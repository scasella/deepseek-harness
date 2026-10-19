/** Fork-lineage projection: header parent, inherited cut, and the last inherited turn. */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { ForkLineageProjection } from './types.ts'

const forkLineageSchema: z.ZodType<ForkLineageProjection> = z.object({
  parentSession: z.string().min(1).transform(SessionId).exactOptional(),
  cutSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq).exactOptional(),
  cutTurn: z.number().int().nonnegative().exactOptional(),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

/**
 * Lineage before any event: the header parent and the cut the exact inherited
 * count names.
 * @param header - immutable Session metadata.
 * @param inheritedEventCount - exact fork-inherited prefix length.
 * @returns the initial lineage without a cut turn.
 */
function initForkLineage(header: SessionHeader, inheritedEventCount: SessionLogOffset): ForkLineageProjection {
  return {
    ...header.parentSession === undefined ? {} : { parentSession: header.parentSession },
    ...inheritedEventCount === 0 ? {} : { cutSeq: SessionSeq(inheritedEventCount - 1) },
    createdAt: header.createdAt,
  }
}

/**
 * Record the turn of each inherited `turn/end`; every other event, and every
 * event after the cut, keeps the state reference.
 * @param state - lineage covering all prior events.
 * @param event - next committed Session event.
 * @returns the original or advanced lineage.
 */
function applyForkLineage(state: ForkLineageProjection, event: SessionEvent): ForkLineageProjection {
  if (event.type !== 'turn/end' || state.cutSeq === undefined || event.seq > state.cutSeq) return state
  return { ...state, cutTurn: event.data.turn }
}

/** The `forkLineage` unit registered by the Session Controller (exported for its unit spec). */
export const forkLineageProjectionDefinition = {
  key: 'forkLineage',
  stateSchema: forkLineageSchema,
  init: initForkLineage,
  apply: applyForkLineage,
  wire: { viewSchema: forkLineageSchema, view: state => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'forkLineage', ForkLineageProjection>

/**
 * Register the fork-lineage projection on the calling fiber.
 * @param ctx - Session Controller context.
 */
export function installForkLineageProjection(ctx: Context): void {
  ctx.sessionProjections.register(forkLineageProjectionDefinition)
}
