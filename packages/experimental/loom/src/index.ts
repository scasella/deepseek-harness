/** Experimental Loom Host service: fork families of Sessions, Loom plugin records, and the `loom` Remote namespace. */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import { ApiSessionNotFound, type SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-projection'
import { forkFamily, type LoomFamilyRow } from './family.ts'
import { loomBranchProjection } from './projection.ts'
import { requestViewAt } from './request-at.ts'
import { installLoomTelemetryRedaction } from './telemetry.ts'
import type { LoomFamily, LoomFamilyRequest, LoomRequestAtRequest, LoomRequestView } from './types.ts'

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

/**
 * Loom Host service. It registers the `loomBranch` projection unit and the
 * telemetry redaction rule for `plugin:loom/*` records for its own lifetime,
 * and exposes the `loom` Remote namespace.
 */
export default class Loom extends TypertRemoteService {
  static inject = ['remoteAccess', 'sessionController', 'sessionProjections', 'sessions', 'typert']

  /**
   * @param ctx - Host context carrying the Session Controller, Session store, projection registry, and Remote access policy.
   */
  constructor(ctx: Context) {
    super(ctx, 'loom', { namespace: 'loom' })
    ctx.sessionProjections.register(loomBranchProjection)
    installLoomTelemetryRedaction(ctx)
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
}
