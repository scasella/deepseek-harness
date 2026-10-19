/** Fork cut facts that fold a fork's inherited Turns into one Chat row. */
import type { ForkLineageProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  ConversationTimelineSnapshot, GroupKey, NodeKey, RenderEntry,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ChatConversationViewNode } from '../contract/chat-nodes.ts'

/** Anchor and React key of the inherited-history disclosure row. */
export const INHERITED_ROW_KEY = JSON.stringify(['fork', 'inherited'])

/** React key of the fork-cut Seat wrapper. */
export const FORK_CUT_SEAT_KEY = JSON.stringify(['fork', 'cut'])

/** Parent and cut of a Session with a fork-inherited prefix. */
export interface ChatForkCut {
  readonly parentSession: SessionId
  readonly cutSeq: SessionSeq
  readonly cutTurn?: number
}

/**
 * Select the cut Chat folds at.
 * @param lineage - the Session's `forkLineage` projection, absent until reported.
 * @returns the cut, or undefined for a Session without a parent or an inherited prefix.
 */
export function forkCutOf(lineage: ForkLineageProjection | undefined): ChatForkCut | undefined {
  if (lineage?.parentSession === undefined || lineage.cutSeq === undefined) return undefined
  return {
    parentSession: lineage.parentSession,
    cutSeq: lineage.cutSeq,
    ...lineage.cutTurn === undefined ? {} : { cutTurn: lineage.cutTurn },
  }
}

/**
 * Find the last Turn opened before the cut. A cut inside a Turn inherits that
 * Turn, as the Session statistics count it. Only the window's first Turn can
 * lack a loaded start; such a Turn is known only through the projected
 * `cutTurn`. Turn starts ascend, so a binary search reads O(log n) Turns.
 * @param timeline - loaded Turns in ascending order.
 * @param cut - the fork cut.
 * @returns the Turn number, or undefined when the prefix opens no Turn.
 */
export function lastInheritedTurn(timeline: ConversationTimelineSnapshot, cut: ChatForkCut): number | undefined {
  const { turnOrder, turns } = timeline
  const startOf = (index: number): number | undefined => turns.get(turnOrder[index] as number)?.start?.seq
  let low = 0
  let high = turnOrder.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const start = startOf(middle)
    if (start === undefined || start <= cut.cutSeq) low = middle + 1
    else high = middle
  }
  return low > 0 && startOf(low - 1) !== undefined ? turnOrder[low - 1] : cut.cutTurn
}

/**
 * Count the leading flow entries inherited from the parent. Turn-located rows
 * are inherited through `inheritedTurn`, Session-located rows through the cut
 * seq, and a row without a Node or a group without a Turn counts as own.
 * Inherited entries form a prefix of the render order, so a binary search
 * classifies O(log n) entries instead of scanning the window.
 * @param entries - root flow entries in render order.
 * @param nodeOf - current Chat Node for a root Node reference.
 * @param groupTurnOf - Turn of a root process group.
 * @param cutSeq - seq of the last inherited event.
 * @param inheritedTurn - last Turn opened before the cut, when any.
 * @returns the number of leading inherited entries.
 */
export function inheritedEntryCount(
  entries: readonly RenderEntry[],
  nodeOf: (key: NodeKey) => ChatConversationViewNode | undefined,
  groupTurnOf: (key: GroupKey) => number | undefined,
  cutSeq: SessionSeq,
  inheritedTurn: number | undefined,
): number {
  const inheritedTurnNumber = (turn: number | undefined): boolean =>
    turn !== undefined && inheritedTurn !== undefined && turn <= inheritedTurn
  const inherited = (entry: RenderEntry): boolean => {
    switch (entry.kind) {
      case 'node': {
        const node = nodeOf(entry.key)
        if (node === undefined) return false
        const { location } = node
        return location.kind === 'turn' || location.kind === 'step'
          ? inheritedTurnNumber(location.turn.turn)
          : node.anchorSeq <= cutSeq
      }
      case 'group':
        return inheritedTurnNumber(groupTurnOf(entry.key))
      default:
        return assertNever(entry)
    }
  }
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (inherited(entries[middle] as RenderEntry)) low = middle + 1
    else high = middle
  }
  return low
}
