/** Experimental Loom Host service: fork families of Sessions, Loom plugin records, and the `loom` Remote namespace. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { principalOf, Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import { ApiSessionNotFound, type SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { appendPluginRecord, type SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { forkFamily, type LoomFamilyRow } from './family.ts'
import { loomBranchProjection, loomMarkProjection } from './projection.ts'
import { requestViewAt } from './request-at.ts'
import { LoomBranchRunner } from './runner.ts'
import { installLoomTelemetryRedaction } from './telemetry.ts'
import type {
  LoomBranchRequest,
  LoomBranchValue,
  LoomCancelRequest,
  LoomCancelValue,
  LoomFamily,
  LoomFamilyRequest,
  LoomMarkRequest,
  LoomMarkValue,
  LoomRequestAtRequest,
  LoomRequestView,
  LoomSetStatus,
  LoomSetStatusRequest,
} from './types.ts'

export { LOOM_REQUEST_PREVIEW_MAX_CODE_POINTS } from './request-at.ts'
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

/** Branch admission limits; omitted fields take their schema defaults. */
export interface Config {
  /** Largest number of children one `loom.branch` call may create; a larger request fails before any fork. Default 8. */
  readonly maxBranchesPerRequest?: number
  /** Largest number of Loom children that are being admitted or running their first prompt at once, across every set. Default 4. */
  readonly maxConcurrentBranches?: number
  /**
   * Whether children whose inherited sandbox mode can write their folder may
   * run at once. When false, the default, such children that share a folder
   * run one at a time; read-only children are not limited by it.
   */
  readonly concurrentWritableBranches?: boolean
}

/** Admission limits after schema defaults. */
export type ResolvedConfig = Required<Config>

/**
 * Loom Host service. It registers the `loomBranch` and `loomMark` projection
 * units, the telemetry redaction rule for `plugin:loom/*` records, and the
 * branch runner for its own lifetime, and exposes the `loom` Remote namespace.
 */
export default class Loom extends TypertRemoteService {
  static inject = ['remoteAccess', 'sessionController', 'sessionProjections', 'sessions', 'typert']

  static Config: z<Config, ResolvedConfig> = z.object({
    maxBranchesPerRequest: z.natural().min(1).default(8),
    maxConcurrentBranches: z.natural().min(1).default(4),
    concurrentWritableBranches: z.boolean().default(false),
  })

  private readonly runner: LoomBranchRunner

  /**
   * @param ctx - Host context carrying the Session Controller, Session store, projection registry, and Remote access policy.
   * @param config - branch admission limits after schema defaults.
   */
  constructor(ctx: Context, config: ResolvedConfig) {
    super(ctx, 'loom', { namespace: 'loom' })
    ctx.sessionProjections.register(loomBranchProjection)
    ctx.sessionProjections.register(loomMarkProjection)
    installLoomTelemetryRedaction(ctx)
    this.runner = new LoomBranchRunner(this.ctx, config)
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
