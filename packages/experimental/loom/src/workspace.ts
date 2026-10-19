/**
 * Outcome-first comparison of the siblings at one fork cut, their diffs, and
 * the decisions on them: adopt one and archive the rest, copy a worktree
 * child's change into the source folder, or remove its worktree.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TextBlock } from '@deepseek-ai/dsh-llm'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import type { WorktreeService } from '@deepseek-ai/dsh-experimental-worktree'
import { appendPluginRecord, SessionSeq, type SessionEvent, type SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-stats/types'
import type {} from '@deepseek-ai/dsh-session-title/types'
import type {} from '@deepseek-ai/dsh-token-meter'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceChangesSummary, WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'
import type { LoomBranchSource } from './branch-spec.ts'
import { inspectSession } from './inspect.ts'
import type { RepositoryQueue } from './isolation.ts'
import { ownTestOutcome, type CompiledTestSummary } from './outcomes.ts'
import { ownLoomRecords, type LoomOwnRecords } from './records.ts'
import { ownCost } from './pricing.ts'
import {
  byPath,
  changedTrackedPaths,
  compareText,
  conflictPaths,
  worktreeChanges,
  worktreePatch,
  worktreeUnifiedDiff,
  type WorktreeTarget,
} from './worktree-git.ts'
import type {
  LoomAdoptRequest,
  LoomAdoptValue,
  LoomApplyRequest,
  LoomApplyValue,
  LoomCommandTool,
  LoomCompareDiff,
  LoomCompareDiffFile,
  LoomCompareRequest,
  LoomCompareRow,
  LoomCompareValue,
  LoomDiffRequest,
  LoomDiffValue,
  LoomDiscardRequest,
  LoomDiscardValue,
  LoomIsolationRecord,
  LoomPriceRow,
  LoomSetId,
} from './types.ts'

/** Configured choices the operations read. */
export interface LoomWorkspaceOptions {
  /** Tools whose results count as command output. */
  readonly commandTools: readonly LoomCommandTool[]
  /** Compiled `outcomes.testSummary`. */
  readonly testSummary: readonly CompiledTestSummary[]
  /** Configured `diff.maxBytes`. */
  readonly diffMaxBytes: number
  /** Configured `apply.maxPatchBytes`. */
  readonly applyMaxPatchBytes: number
  /** Configured list prices by provider/model key. */
  readonly prices: ReadonlyMap<string, LoomPriceRow>
}

/** One Session read for the operations, with its own Loom records. */
interface Inspected extends LoomBranchSource {
  readonly sessionId: SessionId
  readonly own: LoomOwnRecords
}

/** Siblings at one cut, each with its list row. */
interface Siblings {
  readonly parent: SessionId
  readonly cutSeq: SessionSeq
  readonly members: readonly { readonly inspected: Inspected; readonly summary: SessionSummary }[]
}

/** Message sources of a prompt that opens a branch's own work. */
const PROMPT_SOURCES: ReadonlySet<string> = new Set(['user', 'loom'])

/**
 * Text of a message's text parts, one part per line.
 * @param event - a user message event.
 * @returns the text.
 */
function promptText(event: SessionEvent<'user/message'>): string {
  return event.data.content.filter((block): block is TextBlock => block.type === 'text').map(block => block.text).join('\n')
}

/**
 * Summed duration of a Session's own ended turns.
 * @param events - complete log.
 * @param inheritedEventCount - inherited prefix length.
 * @returns milliseconds, or undefined before the first own turn ends.
 */
function ownWallMs(events: readonly SessionEvent[], inheritedEventCount: number): number | undefined {
  const started = new Map<number, number>()
  let total: number | undefined
  for (const event of events.slice(inheritedEventCount)) {
    if (event.type === 'turn/start') started.set(event.data.turn, event.time)
    if (event.type !== 'turn/end') continue
    const start = started.get(event.data.turn)
    if (start !== undefined) total = (total ?? 0) + event.time - start
  }
  return total
}

/**
 * Last turn whose `turn/end` lies at or before the cut.
 * @param events - the compared Session's complete log: the parent's own log, or
 *   a fork's log, which holds the parent's prefix through the cut.
 * @param cutSeq - the cut.
 * @returns the turn, or undefined for a cut before every `turn/end`.
 */
function turnAtCut(events: readonly SessionEvent[], cutSeq: number): number | undefined {
  return events.findLast((event): event is SessionEvent<'turn/end'> => event.seq <= cutSeq && event.type === 'turn/end')?.data.turn
}

/**
 * Latest own `workspace/changes` event of each turn, in turn order.
 * @param inspected - the Session.
 * @returns event seqs.
 */
function ownChangeSeqs(inspected: Inspected): number[] {
  const latest = new Map<number, number>()
  for (const event of inspected.events.slice(inspected.inheritedEventCount)) {
    if (event.type === 'workspace/changes') latest.set(event.data.turn, event.seq)
  }
  return [...latest.entries()].sort(([left], [right]) => left - right).map(([, seq]) => seq)
}

/**
 * Unified text of one per-turn file comparison.
 * @param diff - the comparison.
 * @returns Git-style diff text.
 */
function renderFileDiff(diff: WorkspaceFileDiff): string {
  const header = `diff --git a/${diff.display} b/${diff.display}\n`
  switch (diff.kind) {
    case 'binary':
      return `${header}Binary files differ\n`
    case 'oversized':
      return `${header}File too large to compare\n`
    case 'text': {
      const hunks = diff.hunks.map(hunk =>
        `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@\n${hunk.lines.map(line => `${line}\n`).join('')}`)
      return `${header}--- ${diff.before ? `a/${diff.display}` : '/dev/null'}\n+++ ${diff.after ? `b/${diff.display}` : '/dev/null'}\n${hunks.join('')}`
    }
    /* v8 ignore next 2 -- closed WorkspaceFileDiff union. */
    default:
      return assertNever(diff)
  }
}

/** Compare, diff, adopt, apply, and discard, owned by the Loom service for its lifetime. */
export class LoomWorkspace {
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  /**
   * @param ctx - Loom service Context; the teardown that aborts and awaits pending operations is one of its effects.
   * @param options - configured outcomes and limits.
   * @param repositories - per-repository order of the Loom service's Git work.
   */
  constructor(
    private readonly ctx: Context,
    private readonly options: LoomWorkspaceOptions,
    private readonly repositories: RepositoryQueue,
  ) {
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('the Loom service unloaded'))
      await Promise.allSettled([...this.pending])
    }, 'loom: workspace operations')
  }

  /**
   * Siblings at one cut with their outcomes.
   * @param request - a fork, or a set's source or member with the set.
   * @param visible - whether the caller may reach a Session.
   * @param signal - caller cancellation.
   * @returns the parent, the cut, and one row per sibling the caller may reach.
   * @throws RemoteError `session/not-found`, `loom/not-a-fork`, `loom/set-not-found`, or `gateway/internal`
   *   when a sibling's own usage projections are unavailable.
   */
  compare(request: LoomCompareRequest, visible: (sessionId: SessionId) => boolean, signal?: AbortSignal): Promise<LoomCompareValue> {
    return this.track(signal, async (operation) => {
      const target = await this.inspect(request.sessionId, operation)
      const { parent, cutSeq, members } = await this.siblings(target, request.setId, visible, operation)
      const rows: LoomCompareRow[] = []
      for (const { inspected, summary } of members) rows.push(await this.row(inspected, summary, operation))
      const cutTurn = turnAtCut(target.events, cutSeq)
      return { parent, cutSeq, ...cutTurn === undefined ? {} : { cutTurn }, rows }
    })
  }

  /**
   * Unified diff of one branch: Git against the base commit for a worktree
   * child, the per-turn change summaries of its own turns for a shared one.
   * @param request - the branch and an optional file.
   * @param signal - caller cancellation.
   * @returns the text and whether files were left out.
   * @throws RemoteError `session/not-found`, `loom/worktree-unavailable` (`removed`, `missing`), or `loom/diff-unavailable`.
   */
  diff(request: LoomDiffRequest, signal?: AbortSignal): Promise<LoomDiffValue> {
    return this.track(signal, async (operation) => {
      const inspected = await this.inspect(request.sessionId, operation)
      const { isolation } = inspected.own
      if (isolation === undefined) return this.sharedDiff(inspected, request.path, operation)
      const target = await this.worktreeOf(inspected, isolation, operation)
      return worktreeUnifiedDiff(target, request.path, this.options.diffMaxBytes)
    })
  }

  /**
   * Adopt one branch: write `plugin:loom/adopt` into it once, then archive
   * every sibling through the Workspace registry, stopping running ones.
   * Siblings are the other members of its set, or the other forks at its cut
   * when it belongs to no set. Nothing is deleted.
   * @param request - the branch.
   * @param visible - whether the caller may adopt over a Session.
   * @returns the branch and every sibling now archived.
   * @throws RemoteError `session/not-found`, `loom/not-a-fork`, `remote-access/denied` (a sibling), or
   *   `loom/adopt-incomplete` after a sibling's archive failed.
   */
  adopt(request: LoomAdoptRequest, visible: (sessionId: SessionId) => boolean): Promise<LoomAdoptValue> {
    return this.track(undefined, async (operation) => {
      const target = await this.inspect(request.sessionId, operation)
      const setId = target.own.branch?.setId
      const { members } = await this.siblings(target, setId, () => true, operation)
      const siblings = members.map(member => member.inspected.sessionId).filter(id => id !== target.sessionId)
      const denied = siblings.find(id => !visible(id))
      if (denied !== undefined) {
        throw new RemoteError('remote-access/denied', `remote access: loom/adopt: access denied on sibling "${denied}"`, {
          action: 'loom/adopt',
          reason: 'no-allow',
        })
      }
      if (!target.own.adopted) {
        const agent = await this.agentOf(target.sessionId)
        appendPluginRecord(agent.session, 'plugin:loom/adopt', { version: 1, ...setId === undefined ? {} : { setId } })
        await this.ctx.sessions.flush(agent.session)
      }
      const archived: SessionId[] = []
      for (const sibling of siblings) {
        try {
          await this.ctx.workspaceRegistry.archiveSession(sibling, { stopActivity: true })
        } catch (error) {
          throw new RemoteError('loom/adopt-incomplete', `loom.adopt archived ${String(archived.length)} of ${String(siblings.length)} siblings: ${messageOf(error)}`, {
            sessionId: target.sessionId,
            archived,
            remaining: siblings.slice(archived.length),
          }, { cause: error })
        }
        archived.push(sibling)
      }
      return { adopted: target.sessionId, archived }
    })
  }

  /**
   * Copy a worktree child's change into the source folder with `git apply`,
   * then remove the worktree and record its end. Refused before any write
   * when the source folder has tracked changes or the change does not apply;
   * untouched files keep their bytes.
   * @param request - the branch.
   * @returns the paths written.
   * @throws RemoteError `session/not-found`, `session/agent-busy`, `loom/apply-not-isolated`,
   *   `loom/worktree-unavailable`, `loom/isolation-unavailable`, `loom/apply-too-large`, `loom/apply-dirty`,
   *   `loom/apply-conflict`, or `loom/worktree-cleanup-failed` after the change was written.
   */
  apply(request: LoomApplyRequest): Promise<LoomApplyValue> {
    return this.track(undefined, async (operation) => {
      const inspected = await this.inspect(request.sessionId, operation)
      const { isolation } = inspected.own
      if (isolation === undefined) {
        throw new RemoteError('loom/apply-not-isolated', `session "${request.sessionId}" shares the source folder; it has no worktree change to apply`, { sessionId: request.sessionId })
      }
      return this.repositories.run(isolation.repositoryRoot, async () => {
        const target = await this.worktreeOf(inspected, isolation, operation, 'loom.apply')
        return this.maintain(target, 'loom.apply', async (target) => {
          const { worktrees, agent } = target
          const change = await worktreePatch(target, this.options.applyMaxPatchBytes)
          if (change.truncated) {
            throw new RemoteError('loom/apply-too-large', `the change of session "${request.sessionId}" exceeds apply.maxPatchBytes`, {
              sessionId: request.sessionId, limit: this.options.applyMaxPatchBytes,
            })
          }
          const source = isolation.repositoryRoot
          const status = await worktrees.git(agent, { cwd: source, args: ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=no'] }, target.signal)
          const dirty = changedTrackedPaths(status.stdout)
          if (dirty.length > 0) throw new RemoteError('loom/apply-dirty', `the source folder has changes in ${String(dirty.length)} tracked files`, { paths: dirty })
          if (change.patch.length > 0) {
            const check = await worktrees.git(agent, {
              cwd: source, args: ['apply', '--check', '--binary'], stdin: change.patch, allowedExitCodes: [0, 1], disableFilters: true,
            }, target.signal)
            if (check.exitCode !== 0) {
              throw new RemoteError('loom/apply-conflict', `the change of session "${request.sessionId}" does not apply to the source folder`, { paths: conflictPaths(check.stderr) })
            }
            // The write runs to completion once started, so that unloading never leaves a partly applied change.
            await worktrees.git(agent, { cwd: source, args: ['apply', '--binary'], stdin: change.patch, disableFilters: true })
          }
          await this.removeWorktree(target, 'applied', change.paths)
          return { applied: change.paths.map(path => ({ path })) }
        })
      })
    })
  }

  /**
   * Remove the worktree Loom created for one branch, discarding its files and
   * branch, and record its end.
   * @param request - the branch.
   * @returns the removed worktree.
   * @throws RemoteError `session/not-found`, `session/agent-busy`, `loom/worktree-unavailable`, or `loom/isolation-unavailable`.
   */
  discard(request: LoomDiscardRequest): Promise<LoomDiscardValue> {
    return this.track(undefined, async (operation) => {
      const inspected = await this.inspect(request.sessionId, operation)
      const { isolation } = inspected.own
      if (isolation === undefined) throw worktreeUnavailable(request.sessionId, 'shared')
      return this.repositories.run(isolation.repositoryRoot, async () => {
        const target = await this.worktreeOf(inspected, isolation, operation, 'loom.discard')
        return this.maintain(target, 'loom.discard', async (target) => {
          await this.removeWorktree(target, 'discarded', [])
          return { worktreePath: isolation.worktreePath, branchName: isolation.branchName }
        })
      })
    })
  }

  /** Hold the child's idle phase until its filesystem operation and end record settle. */
  private maintain<T>(target: WorktreeTarget, action: string, use: (target: WorktreeTarget) => Promise<T>): Promise<T> {
    try {
      return target.agent.runMaintenance(signal => use({ ...target, signal: AbortSignal.any([target.signal, signal]) }))
    } catch (error: unknown) {
      throw new RemoteError('session/agent-busy', `${action} needs session "${target.agent.id}" to be idle`, {
        reason: `${action} waits until the branch has no active turn or maintenance task`,
      }, { cause: error })
    }
  }

  /**
   * Run one operation under the service lifetime and the caller's cancellation, kept pending until it settles.
   * @param signal - caller cancellation.
   * @param operation - the operation, given the combined signal.
   * @returns its result.
   */
  private async track<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = signal === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, signal])
    if (combined.aborted) throw new RemoteError('gateway/cancelled', 'the Loom operation was cancelled', {})
    const pending = operation(combined)
    this.pending.add(pending)
    try {
      return await pending
    } finally {
      this.pending.delete(pending)
    }
  }

  private async inspect(sessionId: SessionId, signal: AbortSignal): Promise<Inspected> {
    const source = await inspectSession(this.ctx, sessionId, signal)
    return { ...source, sessionId, own: ownLoomRecords(source.events, source.inheritedEventCount) }
  }

  /**
   * Read one listed Session, or undefined when it was deleted after the list read.
   * @param sessionId - the Session.
   * @param signal - cancellation of the read.
   * @returns the Session with its own records.
   * @throws every read failure other than `session/not-found`.
   */
  private async inspectListed(sessionId: SessionId, signal: AbortSignal): Promise<Inspected | undefined> {
    try {
      return await this.inspect(sessionId, signal)
    } catch (error) {
      if (remoteErrorOf(error)?.code === 'session/not-found') return undefined
      throw error
    }
  }

  /**
   * Live Agent of a Session, resumed when it is cold.
   * @param sessionId - the Session.
   * @returns the Agent.
   * @throws the Session Controller's RemoteError, such as `session/not-found`.
   */
  private async agentOf(sessionId: SessionId): Promise<Agent> {
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    return resolved.agent
  }

  /**
   * Siblings at a target's cut, or the members of a set among its source's forks.
   * @param target - a fork, or a set's source or member.
   * @param setId - the set, or undefined for the target's cut.
   * @param visible - whether a sibling is listed.
   * @param signal - cancellation of the reads.
   * @returns the siblings in creation order, the target included when it is one.
   * @throws RemoteError `loom/not-a-fork` without a set for a Session that is not a fork, and
   *   `loom/set-not-found` for a set without a reachable member.
   */
  private async siblings(
    target: Inspected,
    setId: LoomSetId | undefined,
    visible: (sessionId: SessionId) => boolean,
    signal: AbortSignal,
  ): Promise<Siblings> {
    const scope = scopeOf(target, setId)
    const { items } = await this.ctx.sessionController.list({}, signal)
    if (scope.kind === 'cut') {
      const members = await this.forksOf(items, scope.parent, target, visible, signal, (summary) => {
        const hinted = summary.projections?.values.forkLineage?.cutSeq
        return hinted !== undefined && hinted !== scope.cutSeq ? undefined : inspected => inspected.inheritedEventCount - 1 === scope.cutSeq
      })
      return { parent: scope.parent, cutSeq: scope.cutSeq, members }
    }
    for (const parent of scope.parents) {
      const inSet = (inspected: Inspected): boolean => inspected.own.branch?.setId === scope.setId
      const members = await this.forksOf(items, parent, target, visible, signal, () => inSet)
      const first = members[0]?.inspected.own.branch
      if (first !== undefined) return { parent, cutSeq: first.atSeq, members }
    }
    throw new RemoteError('loom/set-not-found', `branch set "${scope.setId}" has no reachable member`, { setId: scope.setId })
  }

  /**
   * Listed forks of one parent that a test keeps, in sibling order.
   * @param items - the Session list.
   * @param parent - the parent whose forks are read.
   * @param target - the addressed Session, reused instead of read again and listed even when the caller could not list it.
   * @param visible - whether the caller may reach a Session.
   * @param signal - cancellation of the reads.
   * @param select - for a list row, undefined to skip it unread, or the test its read Session must pass.
   * @returns the kept forks with their list rows.
   */
  private async forksOf(
    items: readonly SessionSummary[],
    parent: SessionId,
    target: Inspected,
    visible: (sessionId: SessionId) => boolean,
    signal: AbortSignal,
    select: (summary: SessionSummary) => ((inspected: Inspected) => boolean) | undefined,
  ): Promise<{ inspected: Inspected; summary: SessionSummary }[]> {
    const listed = items.flatMap((summary) => {
      const reachable = summary.sessionId === target.sessionId || visible(summary.sessionId)
      const keep = summary.parentSessionId === parent && summary.origin !== 'subagent' && reachable ? select(summary) : undefined
      return keep === undefined ? [] : [{ summary, keep }]
    })
    const read: { summary: SessionSummary; keep: (inspected: Inspected) => boolean; inspected: Inspected | undefined }[] = []
    for (const { summary, keep } of listed) {
      const inspected = summary.sessionId === target.sessionId ? target : await this.inspectListed(summary.sessionId, signal)
      read.push({ summary, keep, inspected })
    }
    const members = read.flatMap(({ summary, keep, inspected }) =>
      inspected !== undefined && keep(inspected) ? [{ inspected, summary }] : [])
    orderMembers(members)
    return members
  }

  /**
   * One compare row.
   * @param inspected - the sibling.
   * @param summary - its list row.
   * @param signal - cancellation of the reads.
   * @returns the row.
   * @throws RemoteError `gateway/internal` when its own usage projections are unavailable.
   */
  private async row(inspected: Inspected, summary: SessionSummary, signal: AbortSignal): Promise<LoomCompareRow> {
    const { sessionId, events, inheritedEventCount, own } = inspected
    const projections = await this.ctx.sessionController.projections({ sessionId }, signal)
    const values = projections?.values
    const usage = values?.tokenUsage?.fork?.own
    const stats = values?.sessionStats?.fork?.own
    if (usage === undefined || stats === undefined) {
      throw new RemoteError('gateway/internal', `loom.compare cannot read the own usage of session "${sessionId}": the tokenUsage and sessionStats projections are unavailable`, {})
    }
    const prompt = events.slice(inheritedEventCount).find((event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message' && PROMPT_SOURCES.has(event.data.source.kind))
    const tests = ownTestOutcome(events, inheritedEventCount, this.options.commandTools, this.options.testSummary)
    const diff = await this.diffStat(inspected, signal)
    const wallMs = ownWallMs(events, inheritedEventCount)
    const mark = values?.loomMark?.mark
    const usd = ownCost(events, inheritedEventCount, this.options.prices)
    return {
      sessionId,
      title: values?.title ?? '',
      prompt: prompt === undefined ? '' : promptText(prompt),
      kind: own.branch?.kind ?? 'fork',
      isolation: own.isolation === undefined ? 'shared' : 'worktree',
      ...own.isolation === undefined ? {} : { worktreeEnded: own.isolationEnded },
      running: summary.running,
      ...tests === undefined ? {} : { tests },
      ...diff === undefined ? {} : { diff },
      own: {
        steps: stats.steps,
        inputTokens: usage.uncachedInputTokens + usage.cacheWriteTokens,
        cachedTokens: usage.cacheReadTokens,
        outputTokens: usage.outputTokens,
        ...usd === undefined ? {} : { usd: { amount: usd, label: 'list price' as const } },
      },
      ...wallMs === undefined ? {} : { wallMs },
      ...mark === undefined ? {} : { mark },
      adopted: own.adopted,
    }
  }

  /**
   * Changed files of one sibling, or undefined when they cannot be read.
   * @param inspected - the sibling.
   * @param signal - cancellation of the reads.
   * @returns the diff summary.
   */
  private async diffStat(inspected: Inspected, signal: AbortSignal): Promise<LoomCompareDiff | undefined> {
    const { isolation } = inspected.own
    if (isolation === undefined) return this.sharedStat(inspected)
    const worktrees = this.ctx.get('worktrees')
    if (inspected.own.isolationEnded || worktrees === undefined) return undefined
    try {
      return await this.worktreeStat(worktrees, inspected, isolation, signal)
    } catch (error) {
      if (signal.aborted) throw error
      // The row stays readable without its diff; the log names the worktree that could not be read.
      this.ctx.logger.warn(`loom: compare cannot read the worktree ${isolation.worktreePath} of session "${inspected.sessionId}": ${messageOf(error)}`)
      return undefined
    }
  }

  private async worktreeStat(
    worktrees: WorktreeService,
    inspected: Inspected,
    isolation: LoomIsolationRecord,
    signal: AbortSignal,
  ): Promise<LoomCompareDiff | undefined> {
    if (!await this.present(worktrees, isolation, signal)) return undefined
    const agent = await this.agentOf(inspected.sessionId)
    return totals(await worktreeChanges({ worktrees, agent, isolation, signal }), 'worktree')
  }

  /**
   * Per-turn change summaries of a shared sibling's own turns, or undefined when this Host does not hold them.
   * @param inspected - the sibling.
   * @returns the summaries in turn order.
   */
  private summaries(inspected: Inspected): { readonly seq: number; readonly summary: WorkspaceChangesSummary }[] | undefined {
    const changes = this.ctx.get('workspaceChanges')
    if (changes === undefined) return undefined
    const summaries: { seq: number; summary: WorkspaceChangesSummary }[] = []
    for (const seq of ownChangeSeqs(inspected)) {
      const summary = changes.summary(inspected.sessionId, seq)
      if (summary === undefined) return undefined
      summaries.push({ seq, summary })
    }
    return summaries
  }

  private sharedStat(inspected: Inspected): LoomCompareDiff | undefined {
    const summaries = this.summaries(inspected)
    if (summaries === undefined) return undefined
    const files = new Map<string, LoomCompareDiffFile>()
    for (const { summary } of summaries) {
      for (const file of summary.files) {
        const previous = files.get(file.display)
        files.set(file.display, {
          path: file.display,
          insertions: (previous?.insertions ?? 0) + file.added,
          deletions: (previous?.deletions ?? 0) + file.deleted,
        })
      }
    }
    return {
      ...totals([...files.values()].sort(byPath), 'workspace-changes'),
      insertions: summaries.reduce((sum, { summary }) => sum + summary.added, 0),
      deletions: summaries.reduce((sum, { summary }) => sum + summary.deleted, 0),
    }
  }

  private async sharedDiff(inspected: Inspected, path: string | undefined, signal: AbortSignal): Promise<LoomDiffValue> {
    const summaries = this.summaries(inspected)
    const changes = this.ctx.get('workspaceChanges')
    if (summaries === undefined || changes === undefined) throw diffUnavailable(inspected.sessionId)
    let unified = ''
    let used = 0
    for (const { seq, summary } of summaries) {
      for (const [index, file] of summary.files.entries()) {
        if (path !== undefined && file.display !== path) continue
        const diff = await changes.diff(inspected.sessionId, seq, index, signal)
        if (diff === undefined) throw diffUnavailable(inspected.sessionId)
        const text = renderFileDiff(diff)
        const bytes = Buffer.byteLength(text)
        if (used + bytes > this.options.diffMaxBytes) return { unified, truncated: true }
        unified += text
        used += bytes
      }
    }
    return { unified, truncated: false }
  }

  /**
   * Whether the repository still registers the worktree's checkout at its path.
   * @param worktrees - the worktree service.
   * @param isolation - the worktree.
   * @param signal - cancellation of the reads.
   * @returns whether the checkout is present.
   */
  private async present(worktrees: WorktreeService, isolation: LoomIsolationRecord, signal: AbortSignal): Promise<boolean> {
    const repository = await worktrees.locate(isolation.worktreePath, signal)
    return repository !== undefined && repository.root === isolation.worktreePath && repository.administration === 'file'
  }

  /**
   * The worktree of a child for a write or a diff: present, not ended, and with an idle live Agent for writes.
   * @param inspected - the child.
   * @param isolation - its isolation record.
   * @param signal - cancellation.
   * @param write - the writing operation, which requires an idle Agent; undefined for a diff.
   * @returns the worktree target.
   * @throws RemoteError `loom/worktree-unavailable`, `loom/isolation-unavailable`, `session/agent-busy`, or the
   *   Session Controller's failure to resume the child.
   */
  private async worktreeOf(
    inspected: Inspected,
    isolation: LoomIsolationRecord,
    signal: AbortSignal,
    write?: string,
  ): Promise<WorktreeTarget> {
    if (inspected.own.isolationEnded) throw worktreeUnavailable(inspected.sessionId, 'removed')
    const worktrees = this.ctx.get('worktrees')
    if (worktrees === undefined) {
      throw new RemoteError('loom/isolation-unavailable', 'the worktree service is not composed', { reason: 'service-unavailable' })
    }
    if (!await this.present(worktrees, isolation, signal)) throw worktreeUnavailable(inspected.sessionId, 'missing')
    const agent = await this.agentOf(inspected.sessionId)
    if (write !== undefined && agent.status === 'running') {
      throw new RemoteError('session/agent-busy', `${write} needs session "${inspected.sessionId}" to be idle`, { reason: `${write} waits until the branch is idle` })
    }
    return { worktrees, agent, isolation, signal }
  }

  /**
   * Remove a worktree in its repository's turn and record its end in the child.
   * @param target - the worktree.
   * @param reason - why it ends.
   * @param applied - paths `loom.apply` wrote before the removal.
   * @throws RemoteError `loom/worktree-cleanup-failed` after an apply, or `loom/worktree-unavailable`
   *   after a discard when Git no longer registers the recorded checkout and branch, or the removal's failure.
   */
  private async removeWorktree(target: WorktreeTarget, reason: 'applied' | 'discarded', applied: readonly string[]): Promise<void> {
    const { worktrees, agent, isolation, signal } = target
    const checkout = { path: isolation.worktreePath, branch: isolation.branchName, repositoryRoot: isolation.repositoryRoot }
    try {
      const removed = await worktrees.remove(agent, checkout, signal)
      if (removed.kind === 'missing') throw worktreeUnavailable(agent.id, 'missing')
    } catch (error) {
      if (reason === 'discarded') throw error
      throw new RemoteError('loom/worktree-cleanup-failed', `the change was applied, but the worktree at ${isolation.worktreePath} could not be removed: ${messageOf(error)}`, {
        sessionId: agent.id, worktreePath: isolation.worktreePath, applied,
      }, { cause: error })
    }
    appendPluginRecord(agent.session, 'plugin:loom/isolation-end', { version: 1, reason })
    await this.ctx.sessions.flush(agent.session)
  }
}

/**
 * Failure of an operation that needs a worktree.
 * @param sessionId - the branch.
 * @param reason - why it has none.
 * @returns the RemoteError.
 */
function worktreeUnavailable(sessionId: SessionId, reason: 'shared' | 'removed' | 'missing'): RemoteError<'loom/worktree-unavailable'> {
  return new RemoteError('loom/worktree-unavailable', `session "${sessionId}" has no worktree: ${reason}`, { sessionId, reason })
}

/**
 * Put siblings in order: creation time, then set, then request index within a
 * set, then Session id; each stable pass keeps the order of the later keys.
 * @param members - siblings, reordered in place.
 */
function orderMembers(members: { readonly inspected: Inspected; readonly summary: SessionSummary }[]): void {
  const keyed = members.map(member => ({
    member,
    createdAt: member.inspected.meta.createdAt,
    setId: member.inspected.own.branch?.setId ?? '',
    index: member.inspected.own.branch?.index ?? 0,
    sessionId: member.inspected.sessionId,
  }))
  keyed.sort((left, right) => compareText(left.sessionId, right.sessionId))
  keyed.sort((left, right) => left.index - right.index)
  keyed.sort((left, right) => compareText(left.setId, right.setId))
  keyed.sort((left, right) => left.createdAt - right.createdAt)
  members.splice(0, members.length, ...keyed.map(entry => entry.member))
}

/**
 * Message of a failure for a diagnostic.
 * @param error - the failure.
 * @returns its message, or its text when it is not an Error.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Which siblings an operation reads: those at a fork's cut, or the members of
 * one set among the forks of the first of `parents` that has any.
 */
type SiblingScope =
  | { readonly kind: 'cut'; readonly parent: SessionId; readonly cutSeq: SessionSeq }
  | { readonly kind: 'set'; readonly parents: readonly SessionId[]; readonly setId: LoomSetId }

/**
 * The siblings a target names.
 * @param target - a fork, or a set's source or member.
 * @param setId - the set, or undefined for the target's cut.
 * @returns the scope. A set's source is a member's recorded source; for a
 *   target outside the set, it is the target itself, or else the target's
 *   fork parent, whose forks hold the variants of the target's first own turn.
 * @throws RemoteError `loom/not-a-fork` without a set for a Session that is not a fork.
 */
function scopeOf(target: Inspected, setId: LoomSetId | undefined): SiblingScope {
  const { meta, inheritedEventCount, own } = target
  const fork = meta.parentSession !== undefined && meta.origin !== 'subagent' && inheritedEventCount > 0 ? meta.parentSession : undefined
  if (setId !== undefined) {
    if (own.branch?.setId === setId) return { kind: 'set', parents: [own.branch.sourceSessionId], setId }
    return { kind: 'set', parents: fork === undefined ? [target.sessionId] : [target.sessionId, fork], setId }
  }
  if (fork === undefined) throw new RemoteError('loom/not-a-fork', `session "${target.sessionId}" is not a fork`, { sessionId: target.sessionId })
  return { kind: 'cut', parent: fork, cutSeq: SessionSeq(inheritedEventCount - 1) }
}

/**
 * Failure of a shared-folder diff this Host cannot read.
 * @param sessionId - the branch.
 * @returns the RemoteError.
 */
function diffUnavailable(sessionId: SessionId): RemoteError<'loom/diff-unavailable'> {
  return new RemoteError('loom/diff-unavailable', `this Host does not hold the changes of session "${sessionId}"`, { sessionId })
}

/**
 * A diff summary from its files.
 * @param files - changed files in path order.
 * @param source - where they were read.
 * @returns the summary with summed line counts.
 */
function totals(files: readonly LoomCompareDiffFile[], source: LoomCompareDiff['source']): LoomCompareDiff {
  return {
    files,
    insertions: files.reduce((sum, file) => sum + file.insertions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    source,
  }
}
