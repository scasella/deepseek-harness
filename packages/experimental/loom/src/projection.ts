/** The `loomBranch` projection unit: a Session's inherited event count and its own Loom branch membership. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { pluginRecordOf, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { LoomBranchRecord, LoomBranchView, LoomRunId, LoomSetId } from './types.ts'

/** Persisted `plugin:loom/branch` payload; any other payload is not membership. */
export const loomBranchRecordSchema: z.ZodType<LoomBranchRecord> = z.object({
  version: z.literal(1),
  setId: z.string().min(1).transform(value => brandString<LoomSetId>(value)),
  sourceSessionId: z.string().min(1).transform(value => SessionId(value)),
  atSeq: z.number().int().nonnegative().transform(value => SessionSeq(value)),
  variant: z.number().int().positive(),
  variantCount: z.number().int().positive(),
  kind: z.enum(['regenerate', 'steer', 'edit', 'variant', 'autoloom']),
  variantKey: z.string().min(1).exactOptional(),
  runId: z.string().min(1).transform(value => brandString<LoomRunId>(value)).exactOptional(),
}).strict().refine(record => record.variant <= record.variantCount, 'variant exceeds variantCount')

const loomBranchViewSchema: z.ZodType<LoomBranchView> = z.object({
  inheritedEventCount: z.number().int().nonnegative(),
  branch: loomBranchRecordSchema.nullable(),
}).strict()

/**
 * Fold one committed event. The first valid own `plugin:loom/branch` record
 * fixes membership; inherited records, later records, and payloads that fail
 * validation leave the state reference unchanged.
 * @param state - membership covering all prior events.
 * @param event - next committed event.
 * @returns the next state, or `state` itself when the event is not new membership.
 */
function applyLoomBranch(state: LoomBranchView, event: SessionEvent): LoomBranchView {
  if (state.branch !== null || event.seq < state.inheritedEventCount) return state
  const record = pluginRecordOf(event)
  if (record?.type !== 'plugin:loom/branch') return state
  const parsed = loomBranchRecordSchema.safeParse(record.data)
  return parsed.success ? { inheritedEventCount: state.inheritedEventCount, branch: parsed.data } : state
}

/** Projection unit published as the `loomBranch` value of every Session. */
export const loomBranchProjection = {
  key: 'loomBranch',
  stateSchema: loomBranchViewSchema,
  stateVersion: 1,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, branch: null }),
  apply: applyLoomBranch,
  wire: { viewSchema: loomBranchViewSchema, view: state => state },
} satisfies ProjectionDefinition<'loomBranch', LoomBranchView>
