/** Session-owned continuation retry identities; inherited requests remain independent. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { SessionContinuationRequests, SessionRequestId } from './types.ts'

/**
 * Register the Host-only continuation retry state on the current fiber.
 * @param ctx - Session Controller context owning the projection registration.
 */
export function installContinuationProjection(ctx: Context): void {
  const requestIdSchema = z.string().transform(value => brandString<SessionRequestId>(value))
  const schema: z.ZodType<SessionContinuationRequests> = z.object({
    inheritedEventCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionLogOffset),
    requestIds: z.array(requestIdSchema).readonly(),
  })
  ctx.sessionProjections.register({
    key: 'sessionContinuationRequests', stateSchema: schema,
    init: (_header, inheritedEventCount): SessionContinuationRequests => ({ inheritedEventCount, requestIds: [] }),
    apply(state, event) {
      if (event.seq < state.inheritedEventCount || event.type !== 'turn/start') return state
      const source = event.data.continuation
      if (source?.kind !== 'user' || !('rpcId' in source)) return state
      return { ...state, requestIds: [...state.requestIds, requestIdSchema.parse(source.rpcId)] }
    },
    stateVersion: 1,
  })
}
