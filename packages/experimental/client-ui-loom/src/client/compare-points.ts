/**
 * Pure reading of the branch points of a fork family for the Compare mode of
 * the Loom tab: the cuts at which Sessions were forked, with the children
 * forked at each, and the point a Session's Compare opens on.
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { LoomFamily } from '@deepseek-ai/dsh-experimental-loom/types'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { forkCutOf, openedTurnAt, projectionValuesOf } from './lineage.ts'

/** One cut of a parent Session and the children forked there. */
export interface LoomBranchPoint {
  /** Row id the tree uses for the same cut: `p:<parentSessionId>:<cutSeq>`. */
  readonly id: string
  readonly parentSessionId: SessionId
  readonly cutSeq: SessionSeq
  /** Turn of the last inherited `turn/end`; absent for a cut before any turn ended. */
  readonly cutTurn?: number
  /** Last parent turn opened before the cut, when the parent's outline has arrived. */
  readonly openedTurn?: number
  /** Children forked at the cut in family order. */
  readonly children: readonly SessionId[]
}

/**
 * Build the row id of one cut.
 * @param parentSessionId - Session whose cut it is.
 * @param cutSeq - cut seq.
 * @returns the id the tree rows and the point picker share.
 */
export function branchPointId(parentSessionId: SessionId, cutSeq: SessionSeq): string {
  return `p:${parentSessionId}:${String(cutSeq)}`
}

/**
 * List the branch points of a family: for each parent in family order, its
 * cuts in seq order. A child whose lineage has not arrived belongs to no point.
 * @param family - the fork family.
 * @param list - client Session list carrying each member's lineage.
 * @returns the points.
 */
export function branchPoints(family: LoomFamily, list: SessionListState): readonly LoomBranchPoint[] {
  const points: LoomBranchPoint[] = []
  for (const parent of family.nodes) {
    const groups = new Map<SessionSeq, { cutTurn: number | undefined; children: SessionId[] }>()
    for (const node of family.nodes) {
      if (node.parentId !== parent.id) continue
      const cut = forkCutOf(list, node.sessionId)
      if (cut === undefined) continue
      const group = groups.get(cut.cutSeq)
      if (group === undefined) groups.set(cut.cutSeq, { cutTurn: cut.cutTurn, children: [node.sessionId] })
      else group.children.push(node.sessionId)
    }
    const parentValues = projectionValuesOf(list, parent.sessionId)
    for (const [cutSeq, group] of [...groups].sort(([left], [right]) => left - right)) {
      const openedTurn = openedTurnAt(parentValues, cutSeq)
      points.push({
        id: branchPointId(parent.sessionId, cutSeq),
        parentSessionId: parent.sessionId,
        cutSeq,
        ...group.cutTurn === undefined ? {} : { cutTurn: group.cutTurn },
        ...openedTurn === undefined ? {} : { openedTurn },
        children: group.children,
      })
    }
  }
  return points
}

/**
 * Pick the point a Session's Compare opens on: the cut the Session was
 * forked at, else the latest cut among its own children, else the family's
 * first point.
 * @param points - the family's branch points.
 * @param list - client Session list.
 * @param sessionId - Session the Loom tab shows.
 * @returns the point, or undefined for a family without one.
 */
export function defaultPoint(
  points: readonly LoomBranchPoint[],
  list: SessionListState,
  sessionId: SessionId,
): LoomBranchPoint | undefined {
  const cut = forkCutOf(list, sessionId)
  const own = cut === undefined ? undefined : points.find(point => point.id === branchPointId(cut.parentId, cut.cutSeq))
  return own ?? points.findLast(point => point.parentSessionId === sessionId) ?? points[0]
}
