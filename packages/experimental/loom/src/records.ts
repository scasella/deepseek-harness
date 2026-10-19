/** Validated reads of the Loom records a Session wrote itself, after its fork cut. */
import { pluginRecordOf, type SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { loomAdoptRecordSchema, loomBranchRecordSchema } from './projection.ts'
import type { LoomBranchRecord, LoomIsolationEndRecord, LoomIsolationRecord } from './types.ts'

const pathSchema = z.string().min(1)

/** Persisted `plugin:loom/isolation` payload; any other payload names no worktree. */
export const loomIsolationRecordSchema: z.ZodType<LoomIsolationRecord> = z.object({
  version: z.literal(1),
  baseCommit: z.string().regex(/^[0-9a-f]{40,64}$/),
  worktreePath: pathSchema,
  branchName: pathSchema,
  repositoryRoot: pathSchema,
}).strict()

/** Persisted `plugin:loom/isolation-end` payload; any other payload ends nothing. */
export const loomIsolationEndRecordSchema: z.ZodType<LoomIsolationEndRecord> = z.object({
  version: z.literal(1),
  reason: z.enum(['applied', 'discarded']),
}).strict()

/** The Loom facts one Session recorded itself. */
export interface LoomOwnRecords {
  /** First valid own `plugin:loom/branch` record. */
  readonly branch?: LoomBranchRecord
  /** First valid own `plugin:loom/isolation` record. */
  readonly isolation?: LoomIsolationRecord
  /** Whether a valid own `plugin:loom/isolation-end` record follows the isolation record. */
  readonly isolationEnded: boolean
  /** Whether a valid own `plugin:loom/adopt` record exists. */
  readonly adopted: boolean
}

/**
 * Fold a Session's own Loom records. Records it inherited at its fork belong
 * to its source and are skipped.
 * @param events - complete Session log.
 * @param inheritedEventCount - events the Session inherited at its fork.
 * @returns the own records.
 */
export function ownLoomRecords(events: readonly SessionEvent[], inheritedEventCount: number): LoomOwnRecords {
  let branch: LoomBranchRecord | undefined
  let isolation: LoomIsolationRecord | undefined
  let isolationEnded = false
  let adopted = false
  for (const event of events.slice(inheritedEventCount)) {
    const record = pluginRecordOf(event)
    switch (record?.type) {
      case 'plugin:loom/branch':
        branch ??= loomBranchRecordSchema.safeParse(record.data).data
        break
      case 'plugin:loom/isolation':
        isolation ??= loomIsolationRecordSchema.safeParse(record.data).data
        break
      case 'plugin:loom/isolation-end':
        isolationEnded ||= isolation !== undefined && loomIsolationEndRecordSchema.safeParse(record.data).success
        break
      case 'plugin:loom/adopt':
        adopted ||= loomAdoptRecordSchema.safeParse(record.data).success
        break
      default:
        // Every other event, Loom or not, carries no fact this fold reads.
        break
    }
  }
  return {
    ...branch === undefined ? {} : { branch },
    ...isolation === undefined ? {} : { isolation },
    isolationEnded,
    adopted,
  }
}
