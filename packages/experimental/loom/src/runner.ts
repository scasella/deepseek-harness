/**
 * The Loom branch runner: Host-memory branch sets whose children are forked
 * lazily, one admission per free concurrency slot, in request order.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, type SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError, remoteErrorOf, type Principal, type RemoteErrorCode } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { resolveBranch, type LoomBranchSource, type LoomBranchSpec, type LoomChildSpec } from './branch-spec.ts'
import type { ResolvedConfig } from './index.ts'
import { inspectSession } from './inspect.ts'
import { resolveIsolation, type LoomWorktreeSpec, type RepositoryQueue } from './isolation.ts'
import type {
  LoomBranchChild,
  LoomBranchRequest,
  LoomIsolationRecord,
  LoomBranchValue,
  LoomCancelValue,
  LoomSetId,
  LoomSetStatus,
  LoomSetStatusChild,
} from './types.ts'

/**
 * Choices a Host caller makes for a branch set it starts for a model or a
 * plugin rather than for a person; the `loom` Remote never passes them.
 */
export interface LoomHostBranchOptions {
  /** Source of every child's prompt, in place of the user source the Remote path writes. */
  readonly source: MessageSource
  /**
   * Runs for each child after its branch record and before its prompt. A
   * throw fails that child: it keeps its Session and gets no prompt.
   * @param agent - the child's Agent.
   * @param child - the child's set and request index.
   */
  readonly prepare?: (agent: Agent, child: { readonly setId: LoomSetId; readonly index: number }) => void
}

/** Lifecycle of one child in Host memory; `admitting` is reported as `queued`. */
type ChildStatus =
  | { readonly state: 'queued' }
  | { readonly state: 'admitting' }
  | { readonly state: 'started'; readonly sessionId: SessionId }
  | { readonly state: 'failed'; readonly code: RemoteErrorCode; readonly message: string; readonly sessionId?: SessionId }
  | { readonly state: 'cancelled' }

interface ChildEntry {
  readonly spec: LoomChildSpec
  status: ChildStatus
  finished: boolean
}

/** One branch set: its resolved spec and every child's current status. */
interface SetEntry {
  readonly setId: LoomSetId
  /** Session the branch request named; `status` and `cancel` check the caller's access through it. */
  readonly addressedSessionId: SessionId
  readonly spec: LoomBranchSpec
  /** Request identity each child's `rpcId` derives from. */
  readonly requestId: string
  readonly requestKey: string
  /** Non-owner caller recorded on every child prompt. */
  readonly principal: Principal | undefined
  /** Host caller's prompt source and preparation, absent for a Remote call. */
  readonly host: LoomHostBranchOptions | undefined
  readonly children: readonly ChildEntry[]
  /** Repository each child gets a worktree from; absent for a set that shares the source folder. */
  readonly worktree?: LoomWorktreeSpec
  /** Base commit of the set's first worktree, which every later child of the set starts from. */
  base?: string
}

interface QueuedChild {
  readonly set: SetEntry
  readonly child: ChildEntry
}

/**
 * Branch sets held in Host memory for the runner's plugin lifetime. A child
 * holds a slot from its admission until its Agent reaches whole-agent idle
 * after the child's prompt, or until its admission fails. Admission takes the
 * first queued child whose slot rules allow it, so children of one set start
 * in index order and sets start in request order.
 */
export class LoomBranchRunner {
  private readonly sets = new Map<LoomSetId, SetEntry>()
  private readonly requests = new Map<string, Promise<LoomBranchValue>>()
  private readonly queue: QueuedChild[] = []
  private readonly writing = new Set<string>()
  private readonly admissions = new Set<Promise<void>>()
  private running = 0
  private closed = false

  /**
   * @param ctx - Loom service Context; the runner's teardown is one of its effects.
   * @param limits - admission limits and isolation choices from the Loom `Config`.
   * @param repositories - per-repository order of the Loom service's Git work.
   */
  constructor(
    private readonly ctx: Context,
    private readonly limits: ResolvedConfig,
    private readonly repositories: RepositoryQueue,
  ) {
    ctx.effect(() => async () => {
      this.closed = true
      for (const { child } of this.queue.splice(0)) child.status = { state: 'cancelled' }
      await Promise.allSettled([...this.admissions])
    }, 'loom: branch runner')
  }

  /**
   * Create one branch set, or return the result of the first call with the
   * same Session and request identity. Children that a slot admits now are
   * forked and prompted before this resolves; the rest stay queued.
   * @param request - the branch request.
   * @param principal - non-owner caller to record on every child prompt.
   * @param visible - whether the caller may branch a Session other than the
   *   addressed one, asked for the fork parent of a first-own-turn regenerate or edit.
   * @param host - a Host caller's prompt source and preparation; undefined for a Remote call.
   * @returns the set and its children as they stand after the immediate
   *   admissions; when the runner was torn down during them, the children it
   *   withdrew read `cancelled`.
   * @throws RemoteError `session/not-found` for an unknown addressed Session,
   *   `remote-access/denied` when `visible` rejects the fork parent of a
   *   first-own-turn regenerate or edit (a parent that no longer exists is
   *   not an error: the children are cut in the addressed fork instead), every
   *   validation failure of {@link resolveBranch}, and `gateway/cancelled` when
   *   the runner is torn down while the call reads those Sessions, before the
   *   set exists.
   */
  branch(
    request: LoomBranchRequest,
    principal: Principal | undefined,
    visible: (sessionId: SessionId) => boolean,
    host?: LoomHostBranchOptions,
  ): Promise<LoomBranchValue> {
    const key = JSON.stringify([request.sessionId, request.requestId])
    const existing = this.requests.get(key)
    if (existing !== undefined) return existing
    const pending = this.create(request, key, principal, visible, host)
    this.requests.set(key, pending)
    // A rejected request created nothing, so a retry resolves it again.
    void pending.catch(() => { this.requests.delete(key) })
    return pending
  }

  /**
   * Current state of every child of one set.
   * @param setId - the set.
   * @param visible - whether the caller may reach the Session the set's branch request named.
   * @returns the set status.
   * @throws RemoteError `loom/set-not-found` for a set this runner does not hold or `visible` rejects.
   */
  status(setId: LoomSetId, visible: (addressed: SessionId) => boolean): LoomSetStatus {
    const set = this.setOf(setId, visible)
    return { setId, sourceSessionId: set.spec.sourceSessionId, children: set.children.map(statusChild) }
  }

  /**
   * Withdraw queued children of one set; children that are being admitted or
   * have finished admission are left alone.
   * @param setId - the set.
   * @param indices - children to withdraw; undefined names every child.
   * @param visible - whether the caller may reach the Session the set's branch request named.
   * @returns the withdrawn indices, ascending.
   * @throws RemoteError `loom/set-not-found` for a set this runner does not hold or `visible` rejects.
   */
  cancel(setId: LoomSetId, indices: readonly number[] | undefined, visible: (addressed: SessionId) => boolean): LoomCancelValue {
    const set = this.setOf(setId, visible)
    const cancelled: number[] = []
    for (const child of set.children) {
      if (child.status.state !== 'queued' || (indices !== undefined && !indices.includes(child.spec.index))) continue
      child.status = { state: 'cancelled' }
      child.finished = true
      this.queue.splice(this.queue.findIndex(entry => entry.child === child), 1)
      cancelled.push(child.spec.index)
    }
    this.trimFinished()
    return { cancelled }
  }

  private setOf(setId: LoomSetId, visible: (addressed: SessionId) => boolean): SetEntry {
    const set = this.sets.get(setId)
    if (set === undefined || !visible(set.addressedSessionId)) {
      throw new RemoteError('loom/set-not-found', `branch set "${setId}" is not held by this Host`, { setId })
    }
    return set
  }

  private async create(
    request: LoomBranchRequest,
    requestKey: string,
    principal: Principal | undefined,
    visible: (sessionId: SessionId) => boolean,
    host: LoomHostBranchOptions | undefined,
  ): Promise<LoomBranchValue> {
    const source = await this.inspect(request.sessionId)
    const policy = {
      maxBranchesPerRequest: this.limits.maxBranchesPerRequest,
      defaultSandboxMode: this.ctx.get('sandboxPolicy')?.defaultMode,
      defaultIsolation: this.limits.defaultIsolation,
    }
    let spec = resolveBranch(request, source, { ...policy, redirect: true })
    // A first-own-turn regenerate or edit forks the addressed fork's parent, which the Gateway did not
    // authorize: the caller must be allowed to branch it. A deleted parent is not an error, because the
    // fork's own log holds the whole prefix; the children are then cut in the fork, below it.
    if (spec.sourceSessionId !== request.sessionId) {
      if (!visible(spec.sourceSessionId)) {
        throw new RemoteError('remote-access/denied', `remote access: loom/branch: access denied on fork parent "${spec.sourceSessionId}"`, {
          action: 'loom/branch',
          reason: 'no-allow',
        })
      }
      try {
        await this.inspect(spec.sourceSessionId)
      } catch (error) {
        if (remoteErrorOf(error)?.code !== 'session/not-found') throw error
        spec = resolveBranch(request, source, { ...policy, redirect: false })
      }
    }
    const worktree = await resolveIsolation(this.ctx, spec.isolation, source, spec)
    if (this.closed) throw unloaded()
    const set: SetEntry = {
      setId: brandString<LoomSetId>(`loomset-${randomUUID()}`),
      addressedSessionId: request.sessionId,
      spec,
      requestId: request.requestId,
      requestKey,
      principal,
      host,
      children: spec.children.map(child => ({ spec: child, status: { state: 'queued' }, finished: false })),
      ...worktree === undefined ? {} : { worktree },
    }
    this.sets.set(set.setId, set)
    this.queue.push(...set.children.map(child => ({ set, child })))
    const admissions = this.pump().filter(admission => admission.set === set)
    // Teardown during these admissions withdraws the set's other queued children while the admitted ones run on,
    // so the caller still receives the set id. Awaiting no admissions would let teardown withdraw every child first.
    if (admissions.length > 0) await Promise.all(admissions.map(admission => admission.done))
    this.trimFinished()
    return { setId: set.setId, children: set.children.map(branchChild) }
  }

  /** Keep active sets and at most the configured number of oldest-to-newest finished sets. */
  private trimFinished(): void {
    const finished = [...this.sets.values()].filter(set => set.children.every(child => child.finished && child.status.state !== 'admitting'))
    const evicted = finished.length - this.limits.retainedBranchSets
    for (const set of finished.slice(0, Math.max(0, evicted))) {
      this.sets.delete(set.setId)
      this.requests.delete(set.requestKey)
    }
  }

  /**
   * Read one Session for branch resolution.
   * @param sessionId - Session to read.
   * @returns its header, inherited prefix length, and complete log.
   * @throws RemoteError `session/not-found` when the Session does not exist; other read failures propagate.
   */
  private inspect(sessionId: SessionId): Promise<LoomBranchSource> {
    return inspectSession(this.ctx, sessionId)
  }

  /**
   * Admit queued children while slots are free.
   * @returns the admissions started, each settling when its child has started or failed.
   */
  private pump(): { readonly set: SetEntry; readonly done: Promise<void> }[] {
    const started: { readonly set: SetEntry; readonly done: Promise<void> }[] = []
    for (const entry of [...this.queue]) {
      if (this.closed || this.running >= this.limits.maxConcurrentBranches) break
      const { set, child } = entry
      const shared = set.worktree === undefined && set.spec.writable && !this.limits.concurrentWritableBranches
      const folder = shared ? set.spec.folder : undefined
      if (folder !== undefined && this.writing.has(folder)) continue
      this.queue.splice(this.queue.indexOf(entry), 1)
      this.running += 1
      if (folder !== undefined) this.writing.add(folder)
      child.status = { state: 'admitting' }
      const done = this.admit(set, child, folder)
      this.admissions.add(done)
      void done.finally(() => { this.admissions.delete(done) })
      started.push({ set, done })
    }
    return started
  }

  private release(folder: string | undefined): void {
    this.running -= 1
    if (folder !== undefined) this.writing.delete(folder)
    this.pump()
  }

  /**
   * Fork, record, and prompt one child. The slot is released when the child's
   * Agent reaches whole-agent idle after the prompt, or here when a step
   * before the prompt fails. Never rejects: failures become the child status.
   * @param set - the child's set.
   * @param child - the admitted child.
   * @param folder - folder whose writable slot the child holds, if any.
   */
  private async admit(set: SetEntry, child: ChildEntry, folder: string | undefined): Promise<void> {
    const { spec } = set
    let sessionId: SessionId | undefined
    let prompted = false
    try {
      try {
        ({ sessionId } = await this.ctx.sessionController.fork({
          sessionId: spec.sourceSessionId,
          atSeq: spec.cut,
          ...spec.selection === undefined ? {} : { selection: spec.selection },
        }))
      } catch (error) {
        const failure = remoteErrorOf(error)
        if (failure?.code === 'session/workspace-attach-failed') sessionId = failure.details.sessionId
        throw error
      }
      const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
      if ('error' in resolved) throw resolved.error
      const { agent } = resolved
      for (const id of spec.inheritedPrompts) agent.inbox.remove(id)
      const isolation = set.worktree === undefined ? undefined : await this.isolate(set, set.worktree, agent, sessionId)
      appendPluginRecord(agent.session, 'plugin:loom/branch', {
        version: 1,
        setId: set.setId,
        sourceSessionId: spec.sourceSessionId,
        atSeq: spec.cut,
        kind: spec.kind,
        index: child.spec.index,
        ...child.spec.variantKey === undefined ? {} : { variantKey: child.spec.variantKey },
      })
      if (isolation !== undefined) appendPluginRecord(agent.session, 'plugin:loom/isolation', isolation)
      set.host?.prepare?.(agent, { setId: set.setId, index: child.spec.index })
      const source: MessageSource = set.host?.source ?? {
        kind: 'user',
        rpcId: brandString<SessionRequestId>(`${set.requestId}/${String(child.spec.index)}`),
        ...spec.clientTimeZone === undefined ? {} : { clientTimeZone: spec.clientTimeZone },
        ...set.principal === undefined ? {} : { principal: set.principal },
      }
      agent.followup(createUserMessage({ content: child.spec.content, source }))
      prompted = true
      const release = (): void => {
        child.finished = true
        this.release(folder)
        this.trimFinished()
      }
      void agent.whenIdle().then(release, release)
      await this.ctx.sessions.flush(agent.session)
      child.status = { state: 'started', sessionId }
      this.trimFinished()
    } catch (error) {
      const failure = remoteErrorOf(error)
      const message = error instanceof Error ? error.message : String(error)
      child.status = {
        state: 'failed',
        code: failure?.code ?? 'gateway/internal',
        message,
        ...sessionId === undefined ? {} : { sessionId },
      }
      this.ctx.logger.warn(`loom: child ${String(child.spec.index)} of branch set "${set.setId}" failed: ${message}`)
    } finally {
      if (!prompted) {
        child.finished = true
        this.release(folder)
      }
      this.trimFinished()
    }
  }

  /**
   * Create one child's worktree in its repository's turn and enter it. The
   * set's first worktree starts from the source folder's HEAD plus its
   * uncommitted tracked changes; every later child starts from that commit.
   * @param set - the child's set.
   * @param worktree - the set's repository.
   * @param agent - the child's Agent.
   * @param sessionId - the child's Session, which names its branch.
   * @returns the child's isolation record.
   * @throws RemoteError `loom/isolation-unavailable` when the worktree service unloaded since the set was resolved,
   *   and the worktree service's failures.
   */
  private isolate(set: SetEntry, worktree: LoomWorktreeSpec, agent: Agent, sessionId: SessionId): Promise<LoomIsolationRecord> {
    return this.repositories.run(worktree.repositoryRoot, async () => {
      const worktrees = this.ctx.get('worktrees')
      if (worktrees === undefined) {
        throw new RemoteError('loom/isolation-unavailable', 'the worktree service unloaded before the child was isolated', { reason: 'service-unavailable' })
      }
      const name = `${this.limits.worktreeBranchPrefix}${sessionId}`
      const created = await worktrees.create(agent, set.base === undefined ? { name, includeUncommitted: true } : { name, from: set.base })
      set.base ??= created.baseCommit
      return {
        version: 1,
        baseCommit: created.baseCommit,
        worktreePath: created.path,
        branchName: created.branch,
        repositoryRoot: created.repositoryRoot,
      }
    })
  }
}

/**
 * Failure of a `branch()` call that teardown overtook before its set existed.
 * @returns the RemoteError.
 */
function unloaded(): RemoteError<'gateway/cancelled'> {
  return new RemoteError('gateway/cancelled', 'the Loom service unloaded before the branch call returned', {})
}

/**
 * Report one child as `loom.branch` returns it. A child still being admitted
 * is `queued`. A `cancelled` child was withdrawn by teardown, because
 * `loom.cancel` needs the set id that this result first reports.
 * @param child - child entry.
 * @returns the reported child.
 */
function branchChild({ spec, status }: ChildEntry): LoomBranchChild {
  const { index } = spec
  switch (status.state) {
    case 'started':
    case 'failed':
    case 'cancelled':
      return { index, ...status }
    case 'queued':
    case 'admitting':
      return { index, state: 'queued' }
    /* v8 ignore next 2 -- closed ChildStatus union. */
    default:
      return assertNever(status)
  }
}

/**
 * Report one child as `loom.setStatus` returns it; a child still being admitted is `queued`.
 * @param child - child entry.
 * @returns the reported child.
 */
function statusChild({ spec, status }: ChildEntry): LoomSetStatusChild {
  return status.state === 'admitting' ? { index: spec.index, state: 'queued' } : { index: spec.index, ...status }
}
