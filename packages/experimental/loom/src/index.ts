/** Experimental Loom Host service: fork families of Sessions, Loom plugin records, and the `loom` Remote namespace. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { principalOf, Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import { ApiSessionNotFound, type SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { appendPluginRecord, type Session, type SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { forkFamily, type LoomFamilyRow } from './family.ts'
import { LoomEstimator } from './estimate.ts'
import { counterfactual } from './counterfactual.ts'
import { LoomExporter, type LoomExportConfig } from './export.ts'
import { RepositoryQueue } from './isolation.ts'
import { compileTestSummary, DEFAULT_TEST_SUMMARY } from './outcomes.ts'
import { loomBranchProjection, loomMarkProjection } from './projection.ts'
import { compilePricing, LoomPricing } from './pricing.ts'
import { requestViewAt } from './request-at.ts'
import { LoomBranchRunner, type LoomHostBranchOptions } from './runner.ts'
import { installLoomTelemetryRedaction } from './telemetry.ts'
import { LoomWorkspace } from './workspace.ts'
import { LoomProse, type LoomProbeConfig, type LoomWeaveConfig } from './weave.ts'
import type {
  LoomAdoptRequest,
  LoomAdoptValue,
  LoomApplyRequest,
  LoomApplyValue,
  LoomBranchRequest,
  LoomBranchValue,
  LoomCancelRequest,
  LoomCancelValue,
  LoomCommandTool,
  LoomCompareRequest,
  LoomCompareValue,
  LoomCounterfactualRequest,
  LoomCounterfactualValue,
  LoomChooseRequest,
  LoomCurationValue,
  LoomExportRequest,
  LoomExportValue,
  LoomProbeRequest,
  LoomProbeValue,
  LoomWeaveRequest,
  LoomWeaveStateRequest,
  LoomWeaveState,
  LoomWeaveValue,
  LoomDiffRequest,
  LoomDiffValue,
  LoomDiscardRequest,
  LoomDiscardValue,
  LoomEstimateRequest,
  LoomEstimateValue,
  LoomFamily,
  LoomFamilyRequest,
  LoomIsolation,
  LoomMarkRequest,
  LoomMarkValue,
  LoomPriceRow,
  LoomRequestAtRequest,
  LoomRequestView,
  LoomSetStatus,
  LoomSetStatusRequest,
  LoomTestSummaryPattern,
} from './types.ts'

export { DEFAULT_TEST_SUMMARY } from './outcomes.ts'
export { LOOM_REQUEST_PREVIEW_MAX_CODE_POINTS } from './request-at.ts'
export type { LoomHostBranchOptions } from './runner.ts'
export type { LoomExportConfig } from './export.ts'
export type { LoomProbeConfig, LoomWeaveConfig } from './weave.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Experimental Loom service and `loom` Remote namespace. */
    loom: Loom
  }
}

/**
 * Map one Host list row into the facts a fork family reads.
 * @param summary - visible Session list row.
 * @returns the row, with the parent link dropped for a subagent child.
 */
function familyRow(summary: SessionSummary): LoomFamilyRow {
  const createdAt = summary.projections?.values.forkLineage?.createdAt
  return {
    sessionId: summary.sessionId,
    ...summary.origin === 'subagent' || summary.parentSessionId === undefined ? {} : { forkParentId: summary.parentSessionId },
    ...createdAt === undefined ? {} : { createdAt },
    updatedAt: summary.updatedAt,
    running: summary.running,
    blank: summary.blank,
  }
}

/** How `loom.compare` finds test outcomes in a branch's own command output. */
export interface LoomOutcomesConfig {
  /** Tools whose results count as command output. Default: `bash`, with its `command` argument. */
  readonly commandTools?: LoomCommandTool[]
  /** Summary patterns, tried on every own command result; the last match wins. Default: unittest, pytest, Vitest, and Jest. */
  readonly testSummary?: LoomTestSummaryPattern[]
}

/** Limits of `loom.diff`. */
export interface LoomDiffConfig {
  /** Largest unified diff text in UTF-8 bytes; files beyond it are left out and the result says so. Default 262144. */
  readonly maxBytes?: number
}

/** Limits of `loom.apply`. */
export interface LoomApplyConfig {
  /** Largest change in UTF-8 bytes of its binary patch; a larger one is refused before any write. Default 33554432. */
  readonly maxPatchBytes?: number
}

/** Branch admission limits, isolation, outcomes, and diff limits; omitted fields take their schema defaults. */
export interface Config {
  /** Largest number of children one `loom.branch` call may create; a larger request fails before any fork. Default 8. */
  readonly maxBranchesPerRequest?: number
  /** Largest number of Loom children that are being admitted or running their first prompt at once, across every set. Default 4. */
  readonly maxConcurrentBranches?: number
  /** Finished sets retained in Host memory; oldest finished sets and retry results are evicted first. Default 256. */
  readonly retainedBranchSets?: number
  /** List prices in USD per million tokens, indexed by provider and model; no routes are priced by default. */
  readonly pricing?: LoomPriceRow[]
  /**
   * Whether children whose inherited sandbox mode can write their folder may
   * run at once. When false, the default, such children that share a folder
   * run one at a time; read-only children are not limited by it.
   */
  readonly concurrentWritableBranches?: boolean
  /** Where children keep their files when a `loom.branch` request names no `isolation`. Default `shared`. */
  readonly defaultIsolation?: LoomIsolation
  /**
   * Prefix of the Git branch, and of the directory in the worktree pool, that
   * each isolated child gets; the child's Session id follows it. Default `loom/`.
   */
  readonly worktreeBranchPrefix?: string
  /** How `loom.compare` finds test outcomes. */
  readonly outcomes?: LoomOutcomesConfig
  /** Limits of `loom.diff`. */
  readonly diff?: LoomDiffConfig
  /** Limits of `loom.apply`. */
  readonly apply?: LoomApplyConfig
  /** Prose-generation limits, framing and cache-warming policy. */
  readonly weave?: LoomWeaveConfig
  /** Bounded next-token exploration limits. */
  readonly probe?: LoomProbeConfig
  /** Byte, retention and expiry limits for downloadable snapshots. */
  readonly export?: LoomExportConfig
}

/** Configuration after schema defaults. */
export type ResolvedConfig = Required<Omit<Config, 'outcomes' | 'diff' | 'apply' | 'weave' | 'probe' | 'export'>> & {
  /** Command output matching after defaults. */
  readonly outcomes: Required<LoomOutcomesConfig>
  /** Diff limits after defaults. */
  readonly diff: Required<LoomDiffConfig>
  /** Apply limits after defaults. */
  readonly apply: Required<LoomApplyConfig>
  /** Prose-generation settings after defaults. */
  readonly weave: Required<LoomWeaveConfig>
  /** Token-exploration limits after defaults. */
  readonly probe: Required<LoomProbeConfig>
  /** Download limits after defaults. */
  readonly export: Required<LoomExportConfig>
}

/**
 * Loom Host service. It registers the `loomBranch` and `loomMark` projection
 * units, the telemetry redaction rule for `plugin:loom/*` records, the branch
 * runner, and the compare, diff, adopt, apply, and discard operations for its
 * own lifetime, and exposes the `loom` Remote namespace.
 */
export default class Loom extends TypertRemoteService {
  static inject = ['fs', 'llm', 'remoteAccess', 'sessionController', 'sessionProjections', 'sessions', 'typert', 'workspaceRegistry']

  static Config: z<Config, ResolvedConfig> = z.object({
    maxBranchesPerRequest: z.natural().min(1).default(8),
    maxConcurrentBranches: z.natural().min(1).default(4),
    retainedBranchSets: z.natural().min(1).default(256),
    pricing: z.array(z.object({
      provider: z.string().required(),
      model: z.string().required(),
      inputMissPerMTok: z.number().min(0).required(),
      inputHitPerMTok: z.number().min(0).required(),
      outputPerMTok: z.number().min(0).required(),
    })).default([]),
    concurrentWritableBranches: z.boolean().default(false),
    defaultIsolation: z.union(['shared', 'worktree'] as const).default('shared'),
    worktreeBranchPrefix: z.string().default('loom/'),
    outcomes: z.object({
      commandTools: z.array(z.object({
        name: z.string().required(),
        commandArgument: z.string().required(),
      })).default([{ name: 'bash', commandArgument: 'command' }]),
      testSummary: z.array(z.object({
        name: z.string().required(),
        summary: z.string().required(),
        passed: z.string(),
        failed: z.string(),
        errors: z.string(),
        skipped: z.string(),
        total: z.string(),
      })).default([...DEFAULT_TEST_SUMMARY]),
    }).default({}),
    diff: z.object({ maxBytes: z.natural().min(1).default(262_144) }).default({}),
    apply: z.object({ maxPatchBytes: z.natural().min(1).default(33_554_432) }).default({}),
    weave: z.object({
      maxSiblings: z.natural().min(1).max(16).default(4),
      maxTokens: z.natural().min(1).default(200),
      temperature: z.number().min(0).max(2).default(1),
      topLogprobs: z.natural().max(20).default(10),
      leadDelayMs: z.natural().max(2_147_483_647).default(1500),
      timeoutMs: z.natural().min(1).max(2_147_483_647).default(120_000),
      warmWindowMs: z.natural().default(3_600_000),
      maxPrefixCodePoints: z.natural().min(1).default(262_144),
      framing: z.object({ system: z.string().required(), user: z.string().required() }).default({
        system: 'You are a fiction co-writer. Continue the supplied prose without commentary.', user: 'Continue the story.',
      }),
    }).default({}),
    probe: z.object({
      maxDepth: z.natural().min(1).default(4), cutoff: z.number().min(0).max(1).default(0.02),
      maxRequests: z.natural().min(1).default(32), topLogprobs: z.natural().min(1).max(20).default(20),
    }).default({}),
    export: z.object({
      maxBytes: z.natural().min(1).default(16_777_216), maxDownloads: z.natural().min(1).default(64),
      ttlMs: z.natural().min(1).default(300_000),
    }).default({}),
  })

  private readonly runner: LoomBranchRunner
  private readonly workspace: LoomWorkspace
  private readonly estimator: LoomEstimator
  private readonly pricing: LoomPricing
  private readonly prose: LoomProse
  private readonly exporter: LoomExporter

  /**
   * @param ctx - Host context carrying the Session Controller, Session store, projection registry, and Remote access policy.
   * @param config - configuration after schema defaults.
   * @throws Error naming the setting for a `worktreeBranchPrefix` that cannot start a Git branch name, or an
   *   `outcomes.testSummary` pattern that cannot work, or an invalid/duplicate pricing row; the plugin then fails to load.
   */
  constructor(ctx: Context, config: ResolvedConfig) {
    super(ctx, 'loom', { namespace: 'loom' })
    if (!/^(?:\w[\w.-]*(?:\/\w[\w.-]*)*\/?)?$/.test(config.worktreeBranchPrefix) || config.worktreeBranchPrefix.includes('..')) {
      throw new Error('loom: worktreeBranchPrefix must start a relative Git branch name')
    }
    const testSummary = compileTestSummary(config.outcomes.testSummary)
    const prices = compilePricing(config.pricing)
    ctx.sessionProjections.register(loomBranchProjection)
    ctx.sessionProjections.register(loomMarkProjection)
    installLoomTelemetryRedaction(ctx)
    const repositories = new RepositoryQueue()
    this.runner = new LoomBranchRunner(this.ctx, config, repositories)
    this.estimator = new LoomEstimator(this.ctx, config.maxBranchesPerRequest, prices, config.weave)
    this.pricing = new LoomPricing(this.ctx, prices)
    this.prose = new LoomProse(this.ctx, config)
    this.exporter = new LoomExporter(this.ctx, config.export)
    this.workspace = new LoomWorkspace(this.ctx, {
      commandTools: config.outcomes.commandTools,
      testSummary,
      diffMaxBytes: config.diff.maxBytes,
      applyMaxPatchBytes: config.apply.maxPatchBytes,
      prices,
    }, repositories)
  }

  /**
   * Read the fork family of one visible Session from the current Session list
   * without activating any Agent. The Gateway authorizes the addressed Session
   * through the `sessionId` field the Session Controller registers as the
   * `session` resource, and the result keeps only Sessions the caller may list.
   * It serves callers without a Session list of their own; the Loom browser
   * plugin derives families from its client Session list instead.
   * @param request - any member of the family.
   * @param signal - cancellation for the list read.
   * @returns the visible family rooted at the highest visible fork ancestor.
   * @throws RemoteError `session/not-found` when the caller cannot list the Session.
   */
  @Remote
  async family(request: LoomFamilyRequest, signal: AbortSignal): Promise<LoomFamily> {
    const { items } = await this.ctx.sessionController.list({}, signal)
    const visible = items.filter(item => this.ctx.remoteAccess.allows({ kind: 'session', id: item.sessionId }))
    const family = forkFamily(visible.map(familyRow), request.sessionId)
    if (family === undefined) {
      throw new RemoteError('session/not-found', `Session "${request.sessionId}" is not listed`, { sessionId: request.sessionId })
    }
    return family
  }

  /**
   * Rebuild the model request in force at one event of a Session from its
   * whole log, without activating its Agent: the latest request whose
   * `assistant/message` or `assistant/attempt` settlement is at or before
   * `seq`, with its route, tools, effective system prompt, and messages split
   * at the fork cut. The Gateway authorizes the addressed Session through the
   * `sessionId` field the Session Controller registers as the `session`
   * resource, so a caller without access fails with `remote-access/denied`
   * before this method runs.
   * @param request - Session and event to read.
   * @param signal - cancellation for the Session read.
   * @returns the request view.
   * @throws RemoteError `session/not-found` when the Session does not exist.
   * @throws RemoteError `loom/seq-out-of-range` when `seq` is not a seq of the log or precedes the first request settlement.
   * @throws RemoteError `gateway/internal` when the log holds no `request/header` before the addressed request.
   */
  @Remote
  async requestAt(request: LoomRequestAtRequest, signal: AbortSignal): Promise<LoomRequestView> {
    const { sessionId, seq } = request
    const inspection = await this.ctx.sessionController.inspect(sessionId, signal).catch((error: unknown) => {
      if (error instanceof ApiSessionNotFound) {
        throw new RemoteError('session/not-found', error.message, { sessionId }, { cause: error })
      }
      throw error
    })
    signal.throwIfAborted()
    return requestViewAt(sessionId, inspection, seq, this.ctx.sessions.messageProjections)
  }

  /**
   * Fork a current tool result, replace only its content, then continue the child.
   * The original tool metadata and success/error classification are retained.
   * @param request - source Session, current result and replacement text.
   * @param signal - cancellation before child continuation admission.
   * @returns the new branch and its content replacement event.
   */
  @Remote
  counterfactual(request: LoomCounterfactualRequest, signal: AbortSignal): Promise<LoomCounterfactualValue> {
    const principal = principalOf(this.ctx.invocation)
    return counterfactual(this.ctx, request, { kind: 'user', ...principal === undefined ? {} : { principal } }, signal)
  }

  /**
   * Generate prose siblings at a cursor without changing Chat history.
   * @param request - cursor, authored prefix, sibling count and generation controls.
   * @param signal - caller cancellation.
   * @returns settled siblings in dispatch order, including failures.
   */
  @Remote
  weave(request: LoomWeaveRequest, signal: AbortSignal): Promise<LoomWeaveValue> {
    return this.prose.weave(request, signal)
  }

  /**
   * Read a persisted prose document without activating an Agent.
   * @param request - Session whose prose records to read.
   * @param signal - caller cancellation.
   * @returns generated nodes, current choices and curation totals.
   */
  @Remote
  weaveState(request: LoomWeaveStateRequest, signal: AbortSignal): Promise<LoomWeaveState> {
    return this.prose.state(request.sessionId, signal)
  }

  /**
   * Select one completed prose continuation and retain its curation credit.
   * @param request - Session and chosen node.
   * @param signal - caller cancellation.
   * @returns current curation bits and selected model-token count.
   */
  @Remote
  choose(request: LoomChooseRequest, signal: AbortSignal): Promise<LoomCurationValue> {
    return this.prose.choose(request, signal)
  }

  /**
   * Explore next-token alternatives within configured breadth and depth limits.
   * @param request - prose cursor and optional tighter controls.
   * @param signal - caller cancellation.
   * @returns captured alternatives and request-budget status.
   */
  @Remote
  probe(request: LoomProbeRequest, signal: AbortSignal): Promise<LoomProbeValue> {
    return this.prose.probe(request, signal)
  }

  /**
   * Prepare an owner-authenticated prose or agent-branch download.
   * @param request - path, sibling set or kept branches and optional output format.
   * @param signal - caller cancellation.
   * @returns the immutable download URL and filename; the snapshot expires by configuration.
   */
  @Remote
  export(request: LoomExportRequest, signal: AbortSignal): Promise<LoomExportValue> {
    if (principalOf(this.ctx.invocation) !== undefined) throw new RemoteError('loom/export-unavailable',
      'Downloads require the Host owner connection.', { sessionId: request.sessionId, reason: 'owner-connection-required' })
    return this.exporter.create(request, this.canReach(), signal)
  }

  /**
   * Branch one Session into a set of fork children, each cut at the request's
   * turn boundary and sent its own prompt. A regenerate or edit of the first
   * turn a fork Session started itself forks that fork's parent at the fork's
   * cut instead, so the children become further variants beside the fork.
   * Without a `selection`, those children take the route the fork selected
   * before that turn. When that parent no longer exists, the children are cut
   * in the addressed fork instead, below it. Every request validation runs
   * before any fork, except that the Session Controller validates `selection`
   * in each child's fork, so an unavailable route fails each child with
   * `session/model-unavailable` and not the request. A child is
   * forked only when a concurrency slot admits it, so a queued child has no
   * Session; the runner removes the next-turn prompts the child inherited from
   * the cut, writes its `plugin:loom/branch` record, and then sends its
   * prompt. A retry with the same `requestId` for the same Session returns the
   * first result. The Gateway authorizes the addressed Session through its
   * `sessionId` field; the method itself requires `loom/branch` on a fork
   * parent it branches instead.
   * @param request - addressed Session, cut, prompts, and optional route.
   * @returns the set and each child as it stood when the call returned; a child the service's unloading withdrew
   *   meanwhile reads `cancelled`.
   * @throws RemoteError `session/not-found` (the addressed Session), `remote-access/denied`
   *   (the fork parent, while it exists), `gateway/bad-request`, `loom/too-many-branches`, `loom/empty-line`,
   *   `loom/turn-unavailable`, or `gateway/cancelled` (the service unloaded before the set existed), each before
   *   any fork.
   */
  @Remote
  branch(request: LoomBranchRequest): Promise<LoomBranchValue> {
    return this.runner.branch(request, principalOf(this.ctx.invocation), this.canReach())
  }

  /**
   * Branch one Session for a Host caller acting for a model or a plugin:
   * {@link branch} with every validation, admission rule, and retry identity,
   * except that each child's prompt carries `options.source` and
   * `options.prepare` runs on each child before its prompt. It is not a Remote
   * method and authorizes nothing; the caller decides which Sessions it may
   * branch.
   * @param request - addressed Session, cut, prompts, and optional route.
   * @param options - the prompt source and the per-child preparation.
   * @returns the set and each child as it stood when the call returned.
   * @throws RemoteError as {@link branch} does, except `remote-access/denied`.
   */
  branchFor(request: LoomBranchRequest, options: LoomHostBranchOptions): Promise<LoomBranchValue> {
    return this.runner.branch(request, undefined, () => true, options)
  }

  /**
   * Read the list-price cost of a live Session's own settled requests for a Host budget watcher.
   * Each request uses its logged route; inherited work costs nothing. Reads are incremental and activate no Agent.
   * @param session - live Session to price.
   * @returns USD, or undefined if an own request lacks prices or usage, or no priced route has been logged yet.
   */
  ownUsd(session: Session): number | undefined {
    return this.pricing.ownUsd(session)
  }

  /**
   * Preview branching from a repeated turn or visible fork family's own usage,
   * or prose from its route's recorded own Weave input and output cap.
   * Ranges are USD at configured list prices when priced, otherwise token counts. The read creates no forks and activates no Agent.
   * The Gateway authorizes the addressed Session through its `sessionId`; family members are filtered by the caller's access.
   * @param request - Session, operation, sibling count, optional route, and turn or prose controls.
   * @param signal - cancellation of Session and projection reads.
   * @returns per-branch and total ranges, cache share, and the source of the token figures.
   * @throws RemoteError `session/not-found`, `gateway/bad-request`, `loom/too-many-branches`, `loom/turn-unavailable`,
   *   `loom/prose-unavailable` for prose limits, or `gateway/internal` when required own usage projections are missing.
   */
  @Remote
  estimate(request: LoomEstimateRequest, signal: AbortSignal): Promise<LoomEstimateValue> {
    return this.estimator.estimate(request, this.canReach(), signal)
  }

  /**
   * Read every child of one branch set from Host memory, which a Host
   * restart clears.
   * @param request - the set.
   * @returns each child's state, Session, and failure.
   * @throws RemoteError `loom/set-not-found` for a set this Host does not hold or whose addressed Session the caller cannot access.
   */
  @Remote
  setStatus(request: LoomSetStatusRequest): LoomSetStatus {
    return this.runner.status(request.setId, this.canReach())
  }

  /**
   * Withdraw queued children of one branch set before they have a Session.
   * @param request - the set and, optionally, the child indices to withdraw.
   * @returns the indices withdrawn by this call.
   * @throws RemoteError `loom/set-not-found` for a set this Host does not hold or whose addressed Session the caller cannot access.
   */
  @Remote
  cancel(request: LoomCancelRequest): LoomCancelValue {
    return this.runner.cancel(request.setId, request.indices, this.canReach())
  }

  /**
   * Compare the siblings at one fork cut, or the members of one set, by
   * outcome: test summaries from each branch's own command output, changed
   * files, own usage, own wall time, marks, and adoption. Rows cover only
   * Sessions the caller may reach. A worktree row's diff resumes its Session
   * when it is cold. The Gateway authorizes the addressed Session through its
   * `sessionId` field.
   * @param request - a fork, or a set's source or member with the set.
   * @param signal - cancellation of the reads.
   * @returns the parent, the cut, and one row per sibling.
   * @throws RemoteError `session/not-found`, `loom/not-a-fork`, `loom/set-not-found`, or `gateway/internal` when a
   *   sibling's own usage projections are unavailable.
   */
  @Remote
  compare(request: LoomCompareRequest, signal: AbortSignal): Promise<LoomCompareValue> {
    return this.workspace.compare(request, this.canReach(), signal)
  }

  /**
   * Unified diff of one branch: Git against its base commit for a worktree
   * child, untracked files included, or the change summaries of its own turns
   * for a child that shares the source folder. The Gateway authorizes the
   * Session through its `sessionId` field.
   * @param request - the branch and an optional file.
   * @param signal - cancellation of the reads.
   * @returns the text and whether files were left out to stay within `diff.maxBytes`.
   * @throws RemoteError `session/not-found`, `loom/worktree-unavailable`, or `loom/diff-unavailable`.
   */
  @Remote
  diff(request: LoomDiffRequest, signal: AbortSignal): Promise<LoomDiffValue> {
    return this.workspace.diff(request, signal)
  }

  /**
   * Adopt one branch as the line to continue: record `plugin:loom/adopt` in
   * it, then archive its siblings, the other members of its set or the other
   * forks at its cut, through the Workspace registry, stopping their running
   * work first. Nothing is deleted. The Gateway authorizes the branch through
   * its `sessionId` field; the method requires `loom/adopt` on every sibling
   * before any write.
   * @param request - the branch.
   * @returns the branch and every sibling now archived.
   * @throws RemoteError `session/not-found`, `loom/not-a-fork`, `remote-access/denied`, or `loom/adopt-incomplete`.
   */
  @Remote
  adopt(request: LoomAdoptRequest): Promise<LoomAdoptValue> {
    return this.workspace.adopt(request, this.canReach())
  }

  /**
   * Copy an idle worktree branch's change into the source folder with
   * `git apply`, then remove the worktree. Refused before any write when the
   * source folder has tracked changes, the change does not apply, or it
   * exceeds `apply.maxPatchBytes`. The Gateway authorizes the branch through
   * its `sessionId` field.
   * @param request - the branch.
   * @returns the paths written.
   * @throws RemoteError `session/not-found`, `session/agent-busy`, `loom/apply-not-isolated`, `loom/worktree-unavailable`,
   *   `loom/isolation-unavailable`, `loom/apply-too-large`, `loom/apply-dirty`, `loom/apply-conflict`, or
   *   `loom/worktree-cleanup-failed`.
   */
  @Remote
  apply(request: LoomApplyRequest): Promise<LoomApplyValue> {
    return this.workspace.apply(request)
  }

  /**
   * Remove the worktree Loom created for an idle branch, with its files and
   * Git branch; no other worktree is touched. The Gateway authorizes the
   * branch through its `sessionId` field.
   * @param request - the branch.
   * @returns the removed worktree.
   * @throws RemoteError `session/not-found`, `session/agent-busy`, `loom/worktree-unavailable`, or `loom/isolation-unavailable`.
   */
  @Remote
  discard(request: LoomDiscardRequest): Promise<LoomDiscardValue> {
    return this.workspace.discard(request)
  }

  /**
   * Set or clear the private mark of one Session, activating it when it is
   * cold, and flush the `plugin:loom/mark` record. A request for the mark the
   * Session already holds writes nothing. Feedback events are never written.
   * The Gateway authorizes the Session through its `sessionId` field.
   * @param request - the Session and its new mark.
   * @returns the mark in force.
   * @throws RemoteError from resolving the Session's Agent, such as `session/not-found`.
   */
  @Remote
  async mark(request: LoomMarkRequest): Promise<LoomMarkValue> {
    const resolved = await this.ctx.sessionController.resolveAgent(request.sessionId)
    if ('error' in resolved) throw resolved.error
    const { session } = resolved.agent
    if ((this.ctx.sessionProjections.stateOf(session, 'loomMark')?.mark?.mark ?? null) !== request.mark) {
      appendPluginRecord(session, 'plugin:loom/mark', { version: 1, mark: request.mark })
      await this.ctx.sessions.flush(session)
    }
    return { mark: request.mark }
  }

  /**
   * Access check for the Remote call in progress, built from the call's own
   * Context so that `allows()` reads its invocation.
   * @returns whether the call's own action is allowed on a Session.
   */
  private canReach(): (sessionId: SessionId) => boolean {
    const { remoteAccess } = this.ctx
    return sessionId => remoteAccess.allows({ kind: 'session', id: sessionId })
  }
}
