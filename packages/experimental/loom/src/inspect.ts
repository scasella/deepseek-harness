/** Reads of one Session's header and log without activating its Agent. */
import type { Context } from '@deepseek-ai/cordis'
import { ApiSessionNotFound } from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { LoomBranchSource } from './branch-spec.ts'

/**
 * Read one live or stored Session.
 * @param ctx - Context carrying the Session Controller.
 * @param sessionId - Session to read.
 * @param signal - cancellation of a stored read.
 * @returns its header, inherited prefix length, and complete log.
 * @throws RemoteError `session/not-found` when the Session does not exist; other read failures propagate.
 */
export function inspectSession(ctx: Context, sessionId: SessionId, signal?: AbortSignal): Promise<LoomBranchSource> {
  return ctx.sessionController.inspect(sessionId, signal).catch((error: unknown) => {
    if (error instanceof ApiSessionNotFound) {
      throw new RemoteError('session/not-found', error.message, { sessionId }, { cause: error })
    }
    throw error
  })
}
