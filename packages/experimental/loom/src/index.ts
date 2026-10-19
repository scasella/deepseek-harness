/** Experimental Loom Host service: fork families of Sessions, Loom plugin records, and the `loom` Remote namespace. */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-projection'
import { forkFamily, type LoomFamilyRow } from './family.ts'
import { loomBranchProjection } from './projection.ts'
import { installLoomTelemetryRedaction } from './telemetry.ts'
import type { LoomFamily, LoomFamilyRequest } from './types.ts'

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
  static inject = ['remoteAccess', 'sessionController', 'sessionProjections', 'typert']

  /**
   * @param ctx - Host context carrying the Session Controller, projection registry, and Remote access policy.
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
}
