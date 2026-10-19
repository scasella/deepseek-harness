/** Session-list fixtures of branch families for the S2 Loom specs. */
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { forkFamily } from '@deepseek-ai/dsh-experimental-loom/family'
import type { LoomBranchKind, LoomCompareRow, LoomFamily, LoomMark, LoomSetId } from '@deepseek-ai/dsh-experimental-loom/types'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { TurnOutlineEntry } from '@deepseek-ai/dsh-session-turn-outline/client'
import type { LoomTranslate } from '../src/client/format.ts'
import { en, zh } from '../src/client/locales.ts'

export const ROOT = SessionId('root')
export const SET = brandString<LoomSetId>('set-1')
export const SET2 = brandString<LoomSetId>('set-2')
export const tEn = makeTranslate(en, commonEn) as LoomTranslate
export const tZh = makeTranslate(zh, commonZh) as LoomTranslate

/** Facts of one listed Session. */
export interface Member {
  readonly id: string
  readonly parent?: string
  readonly cutSeq?: number
  readonly cutTurn?: number
  readonly createdAt?: number
  readonly branch?: { readonly setId: LoomSetId; readonly kind: LoomBranchKind; readonly index: number; readonly variantKey?: string }
  /** `null` lists the Session as no Loom branch; omission leaves the value unknown. */
  readonly notBranch?: true
  readonly mark?: LoomMark
  readonly outline?: readonly TurnOutlineEntry[]
  readonly running?: boolean
  readonly title?: string
}

/**
 * Build one list row.
 * @param member - the Session's facts.
 * @returns the row.
 */
export function summary(member: Member): SessionSummary {
  const id = SessionId(member.id)
  const parent = member.parent === undefined ? undefined : SessionId(member.parent)
  return {
    id,
    displayTitle: member.title ?? `title ${member.id}`,
    running: member.running ?? false,
    blank: false,
    updatedAt: 1,
    retainedBy: {},
    ...parent === undefined ? {} : { parentId: parent },
    projectionValues: {
      ...parent === undefined || member.cutSeq === undefined ? {} : {
        forkLineage: {
          parentSession: parent,
          cutSeq: SessionSeq(member.cutSeq),
          createdAt: member.createdAt ?? 0,
          ...member.cutTurn === undefined ? {} : { cutTurn: member.cutTurn },
        },
      },
      ...member.branch === undefined
        ? member.notBranch === true ? { loomBranch: null } : {}
        : { loomBranch: { ...member.branch, createdAt: member.createdAt ?? 0 } },
      ...member.mark === undefined ? {} : { loomMark: { mark: member.mark } },
      ...member.outline === undefined ? {} : { turnOutline: member.outline },
    },
  }
}

/**
 * Build a ready Session list.
 * @param members - listed Sessions.
 * @returns the list.
 */
export function listOf(members: readonly Member[]): SessionListState {
  const rows = members.map(summary)
  return { ids: rows.map(item => item.id), byId: Object.fromEntries(rows.map(item => [item.id, item])), phase: 'ready', projectionsBySession: {} }
}

/**
 * Derive the family of one Session from a list.
 * @param list - the list.
 * @param focus - any member.
 * @returns the family.
 */
export function familyIn(list: SessionListState, focus: string): LoomFamily {
  const family = forkFamily(list.ids.map((id) => {
    const item = list.byId[id]
    const createdAt = item?.projectionValues?.forkLineage?.createdAt
    return {
      sessionId: id,
      ...item?.parentId === undefined ? {} : { forkParentId: item.parentId },
      ...createdAt === undefined ? {} : { createdAt },
      updatedAt: 1,
      running: item?.running ?? false,
      blank: false,
    }
  }), SessionId(focus))
  if (family === undefined) throw new Error(`no family for ${focus}`)
  return family
}

/**
 * Build one outline entry.
 * @param turn - turn number.
 * @param seq - `turn/start` seq.
 * @param prompt - prompt preview.
 * @returns the entry.
 */
export function entry(turn: number, seq: number, prompt = ''): TurnOutlineEntry {
  return { turn, seq: SessionSeq(seq), prompt, response: '' }
}

/**
 * Build one compare row; fields not named take a plain shared-folder run.
 * @param id - Session id and title suffix.
 * @param extra - fields to set.
 * @returns the row.
 */
export function compareRow(id: string, extra: Partial<LoomCompareRow> = {}): LoomCompareRow {
  return {
    sessionId: SessionId(id),
    title: `title ${id}`,
    prompt: `prompt ${id}`,
    kind: 'steer',
    isolation: 'shared',
    running: false,
    own: { steps: 3, inputTokens: 100, cachedTokens: 900, outputTokens: 50 },
    adopted: false,
    ...extra,
  }
}
