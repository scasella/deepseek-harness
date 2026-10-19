/**
 * Pure fork facts read from the client Session list: each Session's cut, its
 * variants at that cut, and its own and inherited figures. The fork band, the
 * header chip, the tree, and the reading pane share these readings.
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { loomSessionNode } from '@deepseek-ai/dsh-experimental-loom/family'
import type { LoomBranchView, LoomFamily, LoomMark, LoomMarkView } from '@deepseek-ai/dsh-experimental-loom/types'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type {} from '@deepseek-ai/dsh-session-turn-outline/client'
import type { TokenUsageBuckets } from '@deepseek-ai/dsh-token-meter/client'
import type { LoomMarkOverride } from './branching.ts'

/** Projection values a list row or an explicit projection read carries for one Session. */
export type LoomProjectionValues = Readonly<Partial<SessionProjectionMap>>

/** The cut of one fork Session in its parent's numbering. */
export interface LoomCut {
  /** Fork parent from the Session header. */
  readonly parentId: SessionId
  /** Seq of the last inherited event, equal in parent and child. */
  readonly cutSeq: SessionSeq
  /** Turn of the last inherited `turn/end`; absent when the inherited prefix ends no turn. */
  readonly cutTurn?: number
}

/** Where a Session's inherited prefix ends, in its parent's numbering. */
export interface LoomSplit {
  /** Seq of the last inherited event. */
  readonly cutSeq: SessionSeq
  /** Turn of the last inherited `turn/end`; absent when the inherited prefix ends no turn. */
  readonly cutTurn?: number
}

/** The variants that share one Session's parent and cut. */
export interface LoomVariants extends LoomCut {
  /** Sessions forked from the same parent at the same cut, in family order (creation time, then Session id). */
  readonly members: readonly SessionId[]
  /** One-based position of the requested Session in `members`. */
  readonly index: number
}

/** Turn and step counts of one side of a Session. */
export interface LoomCounts {
  readonly turns: number
  readonly steps: number
}

/**
 * Read the projection values the client holds for one Session.
 * @param list - client Session list.
 * @param sessionId - Session to read.
 * @returns the explicit projection read, else the list row's hints, else undefined.
 */
export function projectionValuesOf(list: SessionListState, sessionId: SessionId): LoomProjectionValues | undefined {
  return list.projectionsBySession[sessionId]?.values ?? list.byId[sessionId]?.projectionValues
}

/**
 * Read the display title of one Session.
 * @param list - client Session list.
 * @param sessionId - Session to name.
 * @returns the list display title, or the Session id for a Session the list does not hold.
 */
export function sessionTitle(list: SessionListState, sessionId: SessionId): string {
  return list.byId[sessionId]?.displayTitle ?? sessionId
}

/**
 * Read the fork cut of one listed Session. A subagent child, a Session
 * without a fork parent, and a Session whose lineage has not arrived have none.
 * @param list - client Session list.
 * @param sessionId - Session to read.
 * @returns the cut, or undefined.
 */
export function forkCutOf(list: SessionListState, sessionId: SessionId): LoomCut | undefined {
  if (list.byId[sessionId]?.origin === 'subagent') return undefined
  const lineage = projectionValuesOf(list, sessionId)?.forkLineage
  if (lineage?.parentSession === undefined || lineage.cutSeq === undefined) return undefined
  return {
    parentId: lineage.parentSession,
    cutSeq: lineage.cutSeq,
    ...lineage.cutTurn === undefined ? {} : { cutTurn: lineage.cutTurn },
  }
}

/**
 * Read where a Session's inherited prefix ends, for every origin. Chat folds
 * the same prefix, a fork-mode subagent child's included, so the reading pane
 * splits own from inherited turns with it; the band, the chip, the tree, and
 * the variants read {@link forkCutOf}, which leaves subagent children out.
 * @param values - the Session's projection values.
 * @returns the split, or undefined for a Session without a fork parent or before its lineage arrives.
 */
export function inheritedSplitOf(values: LoomProjectionValues | undefined): LoomSplit | undefined {
  const lineage = values?.forkLineage
  if (lineage?.parentSession === undefined || lineage.cutSeq === undefined) return undefined
  return { cutSeq: lineage.cutSeq, ...lineage.cutTurn === undefined ? {} : { cutTurn: lineage.cutTurn } }
}

/**
 * Read the last turn a Session inherited, including a turn its cut
 * interrupted. The Session's own outline holds the inherited turns' starts at
 * their parent seqs; before it arrives, the last ended inherited turn stands in.
 * @param values - the Session's projection values.
 * @param split - where the Session's inherited prefix ends.
 * @returns the last inherited turn, or 0 when the prefix opened none.
 */
export function lastInheritedTurnOf(values: LoomProjectionValues | undefined, split: LoomSplit): number {
  return openedTurnAt(values, split.cutSeq) ?? split.cutTurn ?? 0
}

/**
 * Read the last turn a Session had opened by a seq. A fork's cut inside a
 * turn names that turn here, while `cutTurn` names only the last ended one.
 * @param values - projection values of a Session holding the seq, such as the fork parent.
 * @param seq - the cut seq.
 * @returns the turn, or undefined before `turnOutline` arrives or when no turn had started.
 */
export function openedTurnAt(values: LoomProjectionValues | undefined, seq: SessionSeq): number | undefined {
  return values?.turnOutline?.findLast(entry => entry.seq <= seq)?.turn
}

/**
 * Find the variants of one fork Session: family members with the same fork
 * parent and the same cut seq. A parent alone does not make a variant, because
 * one parent can be forked at several cuts.
 * @param family - fork family holding the Session.
 * @param list - client Session list carrying each member's lineage.
 * @param sessionId - Session whose variants are read.
 * @param cut - the Session's cut; omission reads it from the list.
 * @returns the variants, or undefined when the Session has no known cut.
 */
export function variantsOf(
  family: LoomFamily,
  list: SessionListState,
  sessionId: SessionId,
  cut: LoomCut | undefined = forkCutOf(list, sessionId),
): LoomVariants | undefined {
  if (cut === undefined) return undefined
  const parentNode = loomSessionNode(cut.parentId)
  const members = family.nodes
    .filter(node => node.sessionId === sessionId
      || (node.parentId === parentNode && forkCutOf(list, node.sessionId)?.cutSeq === cut.cutSeq))
    .map(node => node.sessionId)
  const position = members.indexOf(sessionId)
  return position < 0 ? { ...cut, members: [sessionId], index: 1 } : { ...cut, members, index: position + 1 }
}

/**
 * List family members whose fork lineage has not arrived, so a caller can ask
 * for their projections. The family root needs no cut.
 * @param family - fork family.
 * @param list - client Session list.
 * @returns members other than the root without a `forkLineage` value.
 */
export function membersWithoutLineage(family: LoomFamily, list: SessionListState): readonly SessionId[] {
  return family.nodes
    .filter(node => node.parentId !== undefined && projectionValuesOf(list, node.sessionId)?.forkLineage === undefined)
    .map(node => node.sessionId)
}

/**
 * Read the turns and steps a Session ran itself.
 * @param values - the Session's projection values.
 * @returns own counts, or undefined before `sessionStats` arrives.
 */
export function ownCounts(values: LoomProjectionValues | undefined): LoomCounts | undefined {
  const stats = values?.sessionStats
  if (stats === undefined) return undefined
  const own = stats.fork?.own ?? stats
  return { turns: own.turns, steps: own.steps }
}

/**
 * Read the turns and steps a fork inherited from its ancestors.
 * @param values - the Session's projection values.
 * @returns inherited counts, or undefined for an unforked Session or before `sessionStats` arrives.
 */
export function inheritedCounts(values: LoomProjectionValues | undefined): LoomCounts | undefined {
  const inherited = values?.sessionStats?.fork?.inherited
  return inherited === undefined ? undefined : { turns: inherited.turns, steps: inherited.steps }
}

/** Sum the four disjoint usage buckets. */
function bucketTotal(buckets: TokenUsageBuckets): number {
  return buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens
}

/**
 * Read the tokens a Session's own requests reported.
 * @param values - the Session's projection values.
 * @returns own total tokens, or undefined before `tokenUsage` arrives.
 */
export function ownTokens(values: LoomProjectionValues | undefined): number | undefined {
  const usage = values?.tokenUsage
  return usage === undefined ? undefined : bucketTotal(usage.fork?.own ?? usage)
}

/**
 * Read a Session's own Loom branch membership.
 * @param values - the Session's projection values.
 * @returns the membership, or undefined for a Session that is not a Loom branch child or before `loomBranch` arrives.
 */
export function branchOf(values: LoomProjectionValues | undefined): LoomBranchView | undefined {
  return values?.loomBranch ?? undefined
}

/**
 * Read the private mark a Session shows: a mark this browser is saving or has
 * just saved, else the `loomMark` projection.
 * @param projected - the Session's `loomMark` value.
 * @param override - this browser's mark state for the Session.
 * @returns the mark, or null for none.
 */
export function markOf(projected: LoomMarkView | null | undefined, override: LoomMarkOverride | undefined): LoomMark | null {
  if (override !== undefined && override.status !== 'failed') return override.mark
  return projected?.mark ?? null
}
