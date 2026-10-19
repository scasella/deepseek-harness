/**
 * Autoloom runs in Host memory: the branch sets and children each weaver
 * Session started, the budget checks every expansion passes before any fork,
 * and the own-token watcher that stops a weaver's children once their own
 * requests use more than the budget.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  LoomBranchChild,
  LoomBranchRequest,
  LoomBranchRequestId,
  LoomBranchValue,
  LoomSetId,
  LoomSetStatus,
  LoomSetStatusChild,
} from '@deepseek-ai/dsh-experimental-loom'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-workspace'
import type { BudgetValue, CullValue, ExpandChildValue, ExpandValue, KeepValue, ReadValue, WaitChildValue, WaitValue } from './schemas.ts'
import type { AutoloomBudget, LoomMessageSource } from './types.ts'

/** Limits the runtime enforces, after schema defaults. */
export interface AutoloomLimits {
  /** Budgets of every weaver Session. */
  readonly autoloom: AutoloomBudget
  /** Wait used when `loom_wait` names no timeout. */
  readonly defaultWaitMs: number
  /** Longest wait `loom_wait` accepts. */
  readonly maxWaitMs: number
  /** Output length `loom_read` returns when it names no limit. */
  readonly defaultReadChars: number
  /** Longest output `loom_read` accepts as a limit. */
  readonly maxReadChars: number
}

/** Why an autoloom tool refused its call; nothing was forked, stopped, or archived. */
export type AutoloomRefusalCode =
  | 'autoloom-child'
  | 'bad-arguments'
  | 'preset-unavailable'
  | 'outside-workspace'
  | 'budget-tokens'
  | 'budget-usd'
  | 'unpriced'
  | 'budget-branches'
  | 'budget-depth'
  | 'unknown-set'
  | 'unknown-child'
  | 'unloaded'

/** A refusal the calling model reads as the tool's error text. */
export class AutoloomRefusal extends Error {
  /**
   * @param code - refusal kind.
   * @param message - model-facing explanation.
   */
  constructor(readonly code: AutoloomRefusalCode, message: string) {
    super(message)
    this.name = 'AutoloomRefusal'
  }
}

/** Cancellation reason of a child the own-token watcher stopped. */
export const BUDGET_STOP_REASON = 'loom: autoloom own-token budget exceeded'

/** Cancellation reason of a child whose list-price usage exceeded its budget or became unpriced. */
export const USD_STOP_REASON = 'loom: autoloom list-price budget exceeded'

/** Cancellation reason of a child the weaver culled. */
export const CULL_STOP_REASON = 'loom: culled by the weaver'

/** Cancellation reason when unloading removes a child's budget watcher. */
export const UNLOADED_STOP_REASON = 'loom: autoloom tools unloaded'

/** One branch set a weaver started. */
interface RunSet {
  readonly setId: LoomSetId
  readonly run: WeaverRun
}

/** One child Session a weaver started. */
interface RunChild {
  readonly sessionId: SessionId
  readonly set: RunSet
  /** Tokens of the child's own requests when last observed. */
  ownTokens: number
  /** List-price dollars of the child's own settled requests; undefined when unpriced. */
  usd: number | undefined
  /** Whether the own-token watcher stopped the child. */
  stoppedByBudget: boolean
  /** Whether the weaver culled the child. */
  archived: boolean
}

/** Every branch set and child one weaver Session started while this plugin was loaded. */
interface WeaverRun {
  readonly sets: Map<LoomSetId, RunSet>
  readonly children: Map<SessionId, RunChild>
  /** Children counted against `maxBranches`. */
  branches: number
  /** Whether the children's own tokens crossed `maxOwnTokens`; no later expansion starts. */
  exhausted: boolean
}

/** `loom_expand` input after schema validation. */
export interface ExpandInput {
  /** Target Session; undefined names the calling weaver. */
  readonly sessionId?: string
  readonly afterTurn: number
  readonly lines?: readonly string[]
  readonly count?: number
}

/**
 * Sum the own buckets of one autoloom child's token usage. Every child is a
 * fork, so its usage carries an own subtotal.
 * @param usage - the child's `tokenUsage` projection value.
 * @returns uncached input, cache read, cache write, and output tokens of its own requests.
 */
function ownTokensOf(usage: TokenUsageProjection): number {
  /* v8 ignore next -- a Loom child inherits at least its cut event, so its usage always carries the fork split. */
  const own = usage.fork?.own ?? usage
  return own.uncachedInputTokens + own.cacheReadTokens + own.cacheWriteTokens + own.outputTokens
}

/**
 * Join the text blocks of one assistant output.
 * @param blocks - the selected output.
 * @returns the text blocks joined by newlines.
 */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/**
 * Report one child of a new branch set to the weaver.
 * @param child - the child as `loom.branch` returned it.
 * @returns the model-facing child.
 */
function expandChild(child: LoomBranchChild): ExpandChildValue {
  if (child.state === 'started') return { index: child.index, state: child.state, sessionId: child.sessionId }
  if (child.state !== 'failed') return { index: child.index, state: child.state }
  return {
    index: child.index,
    state: child.state,
    error: `${child.code}: ${child.message}`,
    ...child.sessionId === undefined ? {} : { sessionId: child.sessionId },
  }
}

/**
 * Autoloom state and enforcement for one plugin lifetime. Runs are keyed by
 * the weaver Session, so an unloaded and resumed weaver keeps its budget; a
 * Host restart or a plugin reload clears every run.
 */
export class AutoloomRuntime {
  private readonly runs = new Map<SessionId, WeaverRun>()
  private readonly children = new Map<SessionId, RunChild>()
  /** Whether a Session's first own prompt carries the `loom` source, known once that prompt exists. */
  private readonly autoloomChildren = new Map<SessionId, boolean>()
  private readonly waiters = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private closed = false
  /** Let every pending wait read its set again. */
  private readonly wake = (): undefined => {
    for (const waiter of [...this.waiters]) waiter()
    return undefined
  }

  /**
   * @param ctx - tool plugin Context; the watcher, the wake listeners, and the teardown are its effects.
   * @param limits - budgets and bounds after schema defaults.
   */
  constructor(private readonly ctx: Context, private readonly limits: AutoloomLimits) {
    ctx.sessionProjections.onChanged((session, key) => {
      if (key === 'tokenUsage') this.observe(session)
    })
    ctx.on('agent/status', this.wake)
    ctx.on('agent/created', this.wake)
    ctx.on('agent/disposed', this.wake)
    ctx.effect(() => async () => {
      this.closed = true
      this.lifetime.abort()
      this.wake()
      this.stopOwned()
      await Promise.allSettled(this.pending)
      this.stopOwned()
      await Promise.allSettled([...this.children.keys()].flatMap((id) => {
        const agent = this.ctx.agents.get(id)
        return agent === undefined ? [] : [agent.whenIdle()]
      }))
      this.runs.clear()
      this.children.clear()
      this.autoloomChildren.clear()
    }, 'tool-loom: autoloom runs')
  }

  private track<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const task = operation(AbortSignal.any([signal, this.lifetime.signal])).finally(() => { this.pending.delete(task) })
    this.pending.add(task)
    return task
  }

  private stopOwned(): void {
    for (const child of this.children.values()) {
      const agent = this.ctx.agents.get(child.sessionId)
      if (agent?.status !== 'running') continue
      try {
        agent.cancel({ kind: 'hook', reason: UNLOADED_STOP_REASON })
      } catch (error: unknown) {
        this.ctx.logger.warn(`tool-loom: child "${child.sessionId}" could not be stopped during unload: ${String(error)}`)
      }
    }
    for (const run of this.runs.values()) for (const set of run.sets.values()) {
      try {
        this.ctx.loom.cancel({ setId: set.setId })
      } catch (error: unknown) {
        if (remoteErrorOf(error)?.code !== 'loom/set-not-found') this.ctx.logger.warn(`tool-loom: queued children of "${set.setId}" could not be withdrawn during unload: ${String(error)}`)
      }
    }
  }

  /**
   * Fork children of one Session after the budget checks, each prompted with
   * the `loom` source and run with the child permission preset.
   * @param agent - the calling weaver.
   * @param input - target, cut, and prompts.
   * @param callId - the `loom_expand` call, which identifies the branch request and its prompts.
   * @param signal - cancellation of the reads before the fork.
   * @returns the new set, its children, and the budget left.
   * @throws AutoloomRefusal before any fork for an autoloom child caller, malformed arguments, an unavailable
   *   preset, a target outside the weaver's working directory, or an exhausted budget; the Loom service's
   *   RemoteError for a request it rejects.
   */
  expand(agent: Agent, input: ExpandInput, callId: ToolCallId, signal: AbortSignal): Promise<ExpandValue> {
    return this.track(signal, operation => this.expandNow(agent, input, callId, operation))
  }

  private async expandNow(agent: Agent, input: ExpandInput, callId: ToolCallId, signal: AbortSignal): Promise<ExpandValue> {
    await this.assertWeaver(agent, signal)
    const requested = requestedChildren(input)
    const permissionPreset = this.childPreset()
    const maxUsd = this.limits.autoloom.maxUsd
    const estimate = maxUsd === undefined ? undefined : await this.ctx.loom.estimate({
      sessionId: input.sessionId === undefined ? agent.session.id : brandString<SessionId>(input.sessionId),
      kind: input.lines === undefined ? 'regenerate' : 'steer',
      ...input.lines === undefined ? { turn: input.afterTurn + 1 } : { afterTurn: input.afterTurn },
      count: requested,
    }, signal)
    const target = input.sessionId === undefined ? agent.session.id : brandString<SessionId>(input.sessionId)
    const lineage = await this.lineage(agent, target, signal)
    this.assertOpen()
    const run = this.runOf(agent.session.id)
    const { maxBranches, maxDepth, maxOwnTokens } = this.limits.autoloom
    if (run.exhausted || this.ownTokens(run) >= maxOwnTokens) {
      throw new AutoloomRefusal('budget-tokens', `The own-token budget of ${String(maxOwnTokens)} tokens for this Session's branches is used up; no branch was created.`)
    }
    if (maxUsd !== undefined) {
      const usd = this.ownUsd(run)
      if (estimate?.priced !== true || estimate.total === undefined || usd === undefined) {
        throw new AutoloomRefusal('unpriced', 'A list-price dollar budget requires configured prices and reported usage for every branch route; no branch was created.')
      }
      if (usd + estimate.total.high > maxUsd || usd >= maxUsd) {
        throw new AutoloomRefusal('budget-usd', `The list-price dollar budget of $${String(maxUsd)} cannot cover this expansion; no branch was created.`)
      }
    }
    if (run.branches + requested > maxBranches) {
      throw new AutoloomRefusal('budget-branches', `This Session may start ${String(maxBranches - run.branches)} more branches, not ${String(requested)}; no branch was created.`)
    }
    // Loom resamples only turns a person opened, so a resample never moves a weaver's child beside its source:
    // every child of this call is one generation below the target's.
    const depth = lineage.filter(id => run.children.has(id)).length + 1
    if (depth > maxDepth) {
      throw new AutoloomRefusal('budget-depth', `These branches would be generation ${String(depth)} of this Session's branches; the limit is ${String(maxDepth)}. No branch was created.`)
    }
    run.branches += requested
    const requestId = brandString<LoomBranchRequestId>(`autoloom/${agent.session.id}/${callId}`)
    const request: LoomBranchRequest = input.lines === undefined
      ? { kind: 'regenerate', sessionId: target, requestId, turn: input.afterTurn + 1, count: requested }
      : { kind: 'steer', sessionId: target, requestId, afterTurn: input.afterTurn, lines: input.lines }
    const source: LoomMessageSource = { kind: 'loom', weaver: agent.session.id, callId }
    // The set is registered when its first child is prepared, so the watcher counts children that start
    // before this call returns; a set none of whose children was prepared yet is registered on return.
    const pending: { set?: RunSet } = {}
    const register = (setId: LoomSetId): RunSet => {
      if (pending.set === undefined) {
        pending.set = { setId, run }
        run.sets.set(setId, pending.set)
      }
      return pending.set
    }
    // A child admitted after the plugin unloaded or the run's budget ran out fails without its prompt.
    const prepare = (child: Agent, { setId }: { readonly setId: LoomSetId }): void => {
      if (this.closed || run.exhausted) {
        // The Loom service records the failure when this throw returns; waits read it on the next turn of the queue.
        queueMicrotask(this.wake)
        throw this.closed
          ? new RemoteError('autoloom/child-refused', 'The loom tools were unloaded; this branch got no prompt.', { reason: 'unloaded' })
          : new RemoteError('autoloom/child-refused', 'The own-token budget of these branches is used up; this branch got no prompt.', { reason: 'budget' })
      }
      this.ctx.permissionPresets.set(child.session, permissionPreset)
      this.autoloomChildren.set(child.session.id, true)
      this.adopt(register(setId), child.session.id)
    }
    let value: LoomBranchValue
    try {
      value = await this.ctx.loom.branchFor(request, { source, prepare })
    } catch (error) {
      run.branches -= requested
      throw error
    }
    if (pending.set === undefined && run.sets.has(value.setId)) {
      // A repeated call: the Loom service returned the set that the first call created and counted.
      run.branches -= requested
    } else {
      const set = register(value.setId)
      run.branches -= value.children.filter(child => child.state === 'cancelled' || (child.state === 'failed' && child.sessionId === undefined)).length
      for (const child of value.children) {
        if ((child.state === 'started' || child.state === 'failed') && child.sessionId !== undefined) this.adopt(set, child.sessionId)
      }
    }
    return { setId: value.setId, children: value.children.map(expandChild), budget: this.budgetLeft(run) }
  }

  /**
   * Wait until every child of one of the weaver's sets is idle, failed, or
   * withdrawn, or until the timeout passes.
   * @param agent - the calling weaver.
   * @param setId - a set the weaver started.
   * @param timeoutMs - longest wait; undefined takes the configured default.
   * @param signal - cancellation of the wait.
   * @returns every child of the set when the wait ended.
   * @throws AutoloomRefusal for an autoloom child caller, a set the weaver did not start or the Loom service no
   *   longer holds, a timeout outside the configured range, or a plugin unload during the wait.
   */
  wait(agent: Agent, setId: string, timeoutMs: number | undefined, signal: AbortSignal): Promise<WaitValue> {
    return this.track(signal, operation => this.waitNow(agent, setId, timeoutMs, operation))
  }

  private async waitNow(agent: Agent, setId: string, timeoutMs: number | undefined, signal: AbortSignal): Promise<WaitValue> {
    await this.assertWeaver(agent, signal)
    this.assertOpen()
    const set = this.setOf(agent, setId)
    const timeout = timeoutMs ?? this.limits.defaultWaitMs
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > this.limits.maxWaitMs) {
      throw new AutoloomRefusal('bad-arguments', `timeoutMs must be an integer from 1 through ${String(this.limits.maxWaitMs)}.`)
    }
    const deadline = Date.now() + timeout
    for (;;) {
      this.assertOpen()
      // Nothing awaits between this check and the listener `nextChange` adds, so no abort is missed.
      signal.throwIfAborted()
      const children = this.waitChildren(set)
      const settled = children.every(child => child.state !== 'queued' && child.state !== 'running')
      const remaining = deadline - Date.now()
      if (settled || remaining <= 0) {
        return { setId: set.setId, timedOut: !settled, children, budget: this.budgetLeft(set.run) }
      }
      await this.nextChange(remaining, signal)
    }
  }

  /**
   * Read the latest output of one of the weaver's children.
   * @param agent - the calling weaver.
   * @param sessionId - a child the weaver started.
   * @param maxChars - output bound in code points; undefined takes the configured default.
   * @param signal - cancellation of the Session read.
   * @returns the child's state, its selected output, and its own token use.
   * @throws AutoloomRefusal for an autoloom child caller, a Session the weaver did not start, or a bound outside
   *   the configured range.
   */
  read(agent: Agent, sessionId: string, maxChars: number | undefined, signal: AbortSignal): Promise<ReadValue> {
    return this.track(signal, operation => this.readNow(agent, sessionId, maxChars, operation))
  }

  private async readNow(agent: Agent, sessionId: string, maxChars: number | undefined, signal: AbortSignal): Promise<ReadValue> {
    await this.assertWeaver(agent, signal)
    this.assertOpen()
    const child = this.childOf(agent, sessionId)
    const limit = maxChars ?? this.limits.defaultReadChars
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.limits.maxReadChars) {
      throw new AutoloomRefusal('bad-arguments', `maxChars must be an integer from 1 through ${String(this.limits.maxReadChars)}.`)
    }
    const inspection = await this.ctx.sessionController.inspect(child.sessionId, signal)
    const points = Array.from(textOf(finalAssistantOutput(inspection.events.slice(inspection.inheritedEventCount)) ?? []))
    const truncated = points.length > limit
    return {
      sessionId: child.sessionId,
      state: this.ctx.agents.get(child.sessionId)?.status === 'running' ? 'running' : 'idle',
      output: (truncated ? points.slice(0, limit) : points).join(''),
      truncated,
      chars: points.length,
      ownTokens: child.ownTokens,
      ...child.stoppedByBudget ? { stoppedByBudget: true as const } : {},
      ...child.archived ? { archived: true as const } : {},
    }
  }

  /**
   * Stop one of the weaver's children when it runs, then archive it.
   * @param agent - the calling weaver.
   * @param sessionId - a child the weaver started.
   * @param signal - cancellation of the caller check.
   * @returns whether the child was running and stopped.
   * @throws AutoloomRefusal for an autoloom child caller or a Session the weaver did not start; the Workspace
   *   registry's failure when the archive cannot be written.
   */
  cull(agent: Agent, sessionId: string, signal: AbortSignal): Promise<CullValue> {
    return this.track(signal, operation => this.cullNow(agent, sessionId, operation))
  }

  private async cullNow(agent: Agent, sessionId: string, signal: AbortSignal): Promise<CullValue> {
    await this.assertWeaver(agent, signal)
    this.assertOpen()
    const child = this.childOf(agent, sessionId)
    const live = this.ctx.agents.get(child.sessionId)
    const stopped = live?.status === 'running'
    if (stopped) live.cancel({ kind: 'hook', reason: CULL_STOP_REASON })
    await this.ctx.workspaceRegistry.archiveSession(child.sessionId, { stopActivity: true })
    child.archived = true
    return { sessionId: child.sessionId, stopped, archived: true }
  }

  /**
   * Mark one of the weaver's children as kept.
   * @param agent - the calling weaver.
   * @param sessionId - a child the weaver started.
   * @param signal - cancellation of the caller check.
   * @returns the mark in force.
   * @throws AutoloomRefusal for an autoloom child caller or a Session the weaver did not start; the Loom
   *   service's failure to write the mark.
   */
  keep(agent: Agent, sessionId: string, signal: AbortSignal): Promise<KeepValue> {
    return this.track(signal, operation => this.keepNow(agent, sessionId, operation))
  }

  private async keepNow(agent: Agent, sessionId: string, signal: AbortSignal): Promise<KeepValue> {
    await this.assertWeaver(agent, signal)
    this.assertOpen()
    const child = this.childOf(agent, sessionId)
    await this.ctx.loom.mark({ sessionId: child.sessionId, mark: 'keep' })
    return { sessionId: child.sessionId, mark: 'keep' }
  }

  /**
   * Refuse a caller whose first own prompt came from a weaver, so that no
   * child starts a run of its own with a fresh budget.
   * @param agent - the caller.
   * @param signal - cancellation of the caller's log read.
   * @throws AutoloomRefusal `autoloom-child` for such a caller.
   */
  private async assertWeaver(agent: Agent, signal: AbortSignal): Promise<void> {
    const { id } = agent.session
    let child = this.autoloomChildren.get(id)
    if (child === undefined) {
      const inspection = await this.ctx.sessionController.inspect(id, signal)
      const first = inspection.events.slice(inspection.inheritedEventCount)
        .find((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
      // A Session without an own prompt yet is not cached: its first prompt decides.
      if (first !== undefined) {
        child = first.data.source.kind === 'loom'
        this.autoloomChildren.set(id, child)
      }
    }
    if (child === true) {
      throw new AutoloomRefusal('autoloom-child', 'This Session is a branch that a weaver started; only the weaver may use the loom tools.')
    }
  }

  /**
   * Resolve the child permission preset at the call, the earliest point where
   * a live Auto preset is known.
   * @returns the preset name.
   * @throws AutoloomRefusal `preset-unavailable` when the preset is not available or asks for approvals.
   */
  private childPreset(): string {
    const name = this.limits.autoloom.childPermissionPreset
    const spec = this.ctx.permissionPresets.names.includes(name) ? this.ctx.permissionPresets.resolve(name) : undefined
    if (spec === undefined || spec.approval !== 'never') {
      throw new AutoloomRefusal('preset-unavailable', `Branches cannot start: their permission preset "${name}" is ${spec === undefined ? 'not available' : 'interactive'} on this Host.`)
    }
    return name
  }

  /**
   * Authorize a target and read its fork ancestors.
   * @param agent - the calling weaver.
   * @param target - the Session to branch.
   * @param signal - cancellation of the lineage read.
   * @returns the target followed by its known fork ancestors, nearest first.
   * @throws AutoloomRefusal `outside-workspace` for a target in another working directory; the Session query's
   *   failure for an unknown target.
   */
  private async lineage(agent: Agent, target: SessionId, signal: AbortSignal): Promise<SessionId[]> {
    const trace = await this.ctx.sessionQuery.traceSession(target, signal)
    const { cwd } = agent.session.header
    if (target !== agent.session.id && (cwd === undefined || trace.target.header.cwd !== cwd)) {
      throw new AutoloomRefusal('outside-workspace', `Session "${target}" is not in this Session's working directory; no branch was created.`)
    }
    return [target, ...trace.ancestors.map(record => record.header.id)]
  }

  private runOf(weaver: SessionId): WeaverRun {
    let run = this.runs.get(weaver)
    if (run === undefined) {
      run = { sets: new Map(), children: new Map(), branches: 0, exhausted: false }
      this.runs.set(weaver, run)
    }
    return run
  }

  private setOf(agent: Agent, setId: string): RunSet {
    const set = this.runs.get(agent.session.id)?.sets.get(brandString<LoomSetId>(setId))
    if (set === undefined) throw new AutoloomRefusal('unknown-set', `"${setId}" is not a branch set this Session started.`)
    return set
  }

  private childOf(agent: Agent, sessionId: string): RunChild {
    const run = this.runs.get(agent.session.id)
    for (const set of run?.sets.values() ?? []) this.refresh(set)
    const child = run?.children.get(brandString<SessionId>(sessionId))
    if (child === undefined) throw new AutoloomRefusal('unknown-child', `"${sessionId}" is not a branch this Session started.`)
    return child
  }

  /**
   * Read one set from the Loom service and adopt children that got a Session since.
   * @param set - a set of a run.
   * @returns the set status, or undefined when the Loom service no longer holds the set.
   */
  private refresh(set: RunSet): LoomSetStatus | undefined {
    let status: LoomSetStatus
    try {
      status = this.ctx.loom.setStatus({ setId: set.setId })
    } catch (error) {
      // A reloaded Loom service forgets its sets; the run keeps the children it already adopted.
      if (remoteErrorOf(error)?.code === 'loom/set-not-found') return undefined
      throw error
    }
    for (const { sessionId } of status.children) {
      if (sessionId !== undefined) this.adopt(set, sessionId)
    }
    return status
  }

  /**
   * Count a child of one of the run's sets, before its first request.
   * @param set - the child's set.
   * @param sessionId - the child.
   */
  private adopt(set: RunSet, sessionId: SessionId): void {
    if (this.children.has(sessionId)) return
    const child: RunChild = { sessionId, set, ownTokens: 0, usd: undefined, stoppedByBudget: false, archived: false }
    this.children.set(sessionId, child)
    set.run.children.set(sessionId, child)
  }

  private waitChildren(set: RunSet): WaitChildValue[] {
    const status = this.refresh(set)
    if (status === undefined) throw new AutoloomRefusal('unknown-set', `Branch set "${set.setId}" is no longer held by this Host.`)
    return status.children.map(child => this.waitChild(child))
  }

  private waitChild(status: LoomSetStatusChild): WaitChildValue {
    const { index, sessionId, state } = status
    const child = sessionId === undefined ? undefined : this.children.get(sessionId)
    const running = sessionId !== undefined && this.ctx.agents.get(sessionId)?.status === 'running'
    return {
      index,
      state: state === 'started' ? (running ? 'running' : 'idle') : state,
      ...sessionId === undefined ? {} : { sessionId },
      ...state === 'failed' ? { error: `${String(status.code)}: ${String(status.message)}` } : {},
      ...child === undefined ? {} : { ownTokens: child.ownTokens },
      ...child?.stoppedByBudget === true ? { stoppedByBudget: true as const } : {},
    }
  }

  /**
   * Resolve on the next Agent status, creation, or disposal, after `ms`, or
   * when the plugin unloads.
   * @param ms - longest wait.
   * @param signal - cancellation of the wait.
   * @returns resolution on any of those events; rejection with the signal's reason on cancellation.
   */
  private nextChange(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const settle = (): void => {
        clearTimeout(timer)
        this.waiters.delete(settle)
        signal.removeEventListener('abort', abort)
      }
      const done = (): void => { settle(); resolve() }
      const abort = (): void => {
        settle()
        reject(signal.reason instanceof Error ? signal.reason : new Error('the wait was cancelled', { cause: signal.reason }))
      }
      const timer = setTimeout(done, ms)
      this.waiters.add(done)
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  /**
   * Record one child's own tokens after a usage change and stop the run's
   * children when their total passes the budget.
   * @param session - the Session whose usage changed.
   */
  private observe(session: Session): void {
    const child = this.children.get(session.id)
    if (child === undefined) return
    const state = this.ctx.sessionProjections.stateOf(session, 'tokenUsage')
    /* v8 ignore next -- the injected token meter registers the unit for the plugin's lifetime. */
    if (state === undefined) return
    child.ownTokens = ownTokensOf(state.usage)
    if (this.limits.autoloom.maxUsd !== undefined) child.usd = this.ctx.loom.ownUsd(session)
    const { run } = child.set
    if (this.ownTokens(run) > this.limits.autoloom.maxOwnTokens) this.exhaust(run)
    const maxUsd = this.limits.autoloom.maxUsd
    if (maxUsd !== undefined) {
      const usd = this.ownUsd(run)
      if (usd === undefined || usd > maxUsd) this.exhaust(run, USD_STOP_REASON)
    }
  }

  /**
   * Stop every running child of a run and withdraw its queued children.
   * @param run - a run whose children crossed `maxOwnTokens`.
   */
  private exhaust(run: WeaverRun, reason: string = BUDGET_STOP_REASON): void {
    if (!run.exhausted) this.ctx.logger.warn(reason === BUDGET_STOP_REASON
      ? `tool-loom: branches crossed the own-token budget of ${String(this.limits.autoloom.maxOwnTokens)}; stopping them`
      : `tool-loom: ${reason}; stopping branches`)
    run.exhausted = true
    for (const child of run.children.values()) {
      const agent = this.ctx.agents.get(child.sessionId)
      if (agent?.status !== 'running') continue
      agent.cancel({ kind: 'hook', reason })
      child.stoppedByBudget = true
    }
    for (const set of run.sets.values()) {
      try {
        this.ctx.loom.cancel({ setId: set.setId })
      } catch (error) {
        // The watcher runs inside a Session commit, so a failed withdrawal is reported, not thrown; an evicted
        // set has no queued children left.
        if (remoteErrorOf(error)?.code !== 'loom/set-not-found') this.ctx.logger.warn(`tool-loom: queued children of branch set "${set.setId}" were not withdrawn: ${String(error)}`)
      }
    }
  }

  private ownTokens(run: WeaverRun): number {
    let total = 0
    for (const child of run.children.values()) total += child.ownTokens
    return total
  }

  /** Sum settled child list prices; unpriced usage makes the whole total unavailable. */
  private ownUsd(run: WeaverRun): number | undefined {
    let total = 0
    for (const child of run.children.values()) {
      const session = this.ctx.agents.get(child.sessionId)?.session
      const usd = session === undefined ? child.usd : this.ctx.loom.ownUsd(session)
      if (usd === undefined) return undefined
      total += usd
    }
    return total
  }

  private budgetLeft(run: WeaverRun): BudgetValue {
    const { maxBranches, maxDepth, maxOwnTokens } = this.limits.autoloom
    return {
      branchesLeft: Math.max(0, maxBranches - run.branches),
      ownTokensLeft: run.exhausted ? 0 : Math.max(0, maxOwnTokens - this.ownTokens(run)),
      maxDepth,
      ...this.limits.autoloom.maxUsd === undefined ? {} : {
        usdLeft: run.exhausted ? 0 : Math.max(0, this.limits.autoloom.maxUsd - (this.ownUsd(run) ?? this.limits.autoloom.maxUsd)),
      },
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new AutoloomRefusal('unloaded', 'The loom tools were unloaded; no branch was changed.')
  }
}

/**
 * Number of children one `loom_expand` call asks for.
 * @param input - validated arguments.
 * @returns the child count.
 * @throws AutoloomRefusal `bad-arguments` unless exactly one of `lines` and `count` is given, `count` is
 *   positive, `lines` is not empty, and `afterTurn` is not negative.
 */
function requestedChildren(input: ExpandInput): number {
  const { lines, count } = input
  let requested: number
  if (lines !== undefined && count === undefined) requested = lines.length
  else if (lines === undefined && count !== undefined) requested = count
  else throw new AutoloomRefusal('bad-arguments', 'Give exactly one of lines and count.')
  if (input.afterTurn < 0) throw new AutoloomRefusal('bad-arguments', 'afterTurn must not be negative.')
  if (requested < 1) throw new AutoloomRefusal('bad-arguments', 'Ask for at least one branch.')
  return requested
}
