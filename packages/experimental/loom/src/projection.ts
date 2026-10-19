/** The `loomBranch` and `loomMark` projection units: a Session's own Loom branch membership, adoption, and private mark. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { pluginRecordOf, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type {
  LoomAdoptRecord,
  LoomBranchRecord,
  LoomBranchState,
  LoomBranchView,
  LoomMarkRecord,
  LoomMarkState,
  LoomMarkView,
  LoomSetId,
} from './types.ts'

const setIdSchema = z.string().min(1).transform(value => brandString<LoomSetId>(value))
const kindSchema = z.enum(['regenerate', 'steer', 'edit', 'variants'])
const markSchema = z.enum(['keep', 'set-aside'])
const indexSchema = z.number().int().nonnegative()
const variantKeySchema = z.string().min(1).exactOptional()
const inheritedEventCountSchema = z.number().int().nonnegative()

/** Persisted `plugin:loom/branch` payload; any other payload is not membership. */
export const loomBranchRecordSchema: z.ZodType<LoomBranchRecord> = z.object({
  version: z.literal(1),
  setId: setIdSchema,
  sourceSessionId: z.string().min(1).transform(value => SessionId(value)),
  atSeq: z.number().int().nonnegative().transform(value => SessionSeq(value)),
  kind: kindSchema,
  index: indexSchema,
  variantKey: variantKeySchema,
}).strict()

/** Persisted `plugin:loom/mark` payload; any other payload changes no mark. */
export const loomMarkRecordSchema: z.ZodType<LoomMarkRecord> = z.object({
  version: z.literal(1),
  mark: markSchema.nullable(),
}).strict()

/** Persisted `plugin:loom/adopt` payload; any other payload is not an adoption. */
export const loomAdoptRecordSchema: z.ZodType<LoomAdoptRecord> = z.object({
  version: z.literal(1),
  setId: setIdSchema.exactOptional(),
}).strict()

const loomBranchViewSchema: z.ZodType<LoomBranchView> = z.object({
  setId: setIdSchema,
  kind: kindSchema,
  index: indexSchema,
  variantKey: variantKeySchema,
  createdAt: z.number().nonnegative(),
  adopted: z.literal(true).exactOptional(),
}).strict()

const loomBranchStateSchema: z.ZodType<LoomBranchState> = z.object({
  inheritedEventCount: inheritedEventCountSchema,
  branch: loomBranchViewSchema.nullable(),
}).strict()

const loomMarkViewSchema: z.ZodType<LoomMarkView> = z.object({ mark: markSchema }).strict()

const loomMarkStateSchema: z.ZodType<LoomMarkState> = z.object({
  inheritedEventCount: inheritedEventCountSchema,
  mark: loomMarkViewSchema.nullable(),
}).strict()

/**
 * Fold one committed event into branch membership. The first valid own
 * `plugin:loom/branch` record fixes membership, with the record's time as
 * `createdAt`; a later valid own `plugin:loom/adopt` record marks it adopted.
 * Inherited records, other records, and payloads that fail validation leave
 * the state reference unchanged.
 * @param state - membership covering all prior events.
 * @param event - next committed event.
 * @returns the next state, or `state` itself when the event changes nothing.
 */
function applyLoomBranch(state: LoomBranchState, event: SessionEvent): LoomBranchState {
  if (event.seq < state.inheritedEventCount) return state
  const record = pluginRecordOf(event)
  if (state.branch === null) {
    if (record?.type !== 'plugin:loom/branch') return state
    const parsed = loomBranchRecordSchema.safeParse(record.data)
    if (!parsed.success) return state
    const { setId, kind, index, variantKey } = parsed.data
    return {
      inheritedEventCount: state.inheritedEventCount,
      branch: { setId, kind, index, ...variantKey === undefined ? {} : { variantKey }, createdAt: event.time },
    }
  }
  if (state.branch.adopted === true || record?.type !== 'plugin:loom/adopt' || !loomAdoptRecordSchema.safeParse(record.data).success) return state
  return { inheritedEventCount: state.inheritedEventCount, branch: { ...state.branch, adopted: true } }
}

/**
 * Fold one committed event into the private mark. Each valid own
 * `plugin:loom/mark` record sets or clears the mark; inherited records,
 * records that repeat the current mark, and payloads that fail validation
 * leave the state reference unchanged.
 * @param state - mark covering all prior events.
 * @param event - next committed event.
 * @returns the next state, or `state` itself when the mark does not change.
 */
function applyLoomMark(state: LoomMarkState, event: SessionEvent): LoomMarkState {
  if (event.seq < state.inheritedEventCount) return state
  const record = pluginRecordOf(event)
  if (record?.type !== 'plugin:loom/mark') return state
  const parsed = loomMarkRecordSchema.safeParse(record.data)
  if (!parsed.success || (state.mark?.mark ?? null) === parsed.data.mark) return state
  return { inheritedEventCount: state.inheritedEventCount, mark: parsed.data.mark === null ? null : { mark: parsed.data.mark } }
}

/** Projection unit published as the `loomBranch` value of every Session: own membership and adoption, or null. */
export const loomBranchProjection = {
  key: 'loomBranch',
  stateSchema: loomBranchStateSchema,
  stateVersion: 3,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, branch: null }),
  apply: applyLoomBranch,
  wire: { viewSchema: loomBranchViewSchema.nullable(), view: state => state.branch },
} satisfies ProjectionDefinition<'loomBranch', LoomBranchState>

/** Projection unit published as the `loomMark` value of every Session: own current mark, or null. */
export const loomMarkProjection = {
  key: 'loomMark',
  stateSchema: loomMarkStateSchema,
  stateVersion: 1,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, mark: null }),
  apply: applyLoomMark,
  wire: { viewSchema: loomMarkViewSchema.nullable(), view: state => state.mark },
} satisfies ProjectionDefinition<'loomMark', LoomMarkState>
