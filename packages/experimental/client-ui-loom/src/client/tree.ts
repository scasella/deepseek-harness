/**
 * Pure outline of one fork family for the Loom tree: Session rows, and under
 * each Session one branch-point row per cut its children were forked at.
 * The result lists only visible rows in document order, with the APG tree
 * positions (`level`, `posinset`, `setsize`) each row announces.
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { LoomFamily, LoomFamilyNode, LoomMark } from '@deepseek-ai/dsh-experimental-loom/types'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { LoomMarkOverride } from './branching.ts'
import { branchOf, forkCutOf, markOf, openedTurnAt, ownCounts, ownTokens, projectionValuesOf, sessionTitle } from './lineage.ts'

/** Activity of one Session row: running, ended with own turns, or without own turns yet. */
export type LoomRowStatus = 'running' | 'done' | 'blank'

/** Fields every tree row carries. */
interface LoomRowBase {
  /** Stable row id: `s:<sessionId>` or `p:<parentSessionId>:<cutSeq>`. */
  readonly id: string
  /** One-based APG level. */
  readonly level: number
  /** Parent row, absent for the family root. */
  readonly parentRowId?: string
  /** One-based position among the rows sharing the parent row. */
  readonly posinset: number
  /** Number of rows sharing the parent row. */
  readonly setsize: number
  /** Whether the row has child rows. */
  readonly expandable: boolean
  /** Whether an expandable row shows its child rows. */
  readonly expanded: boolean
  /** Whether the row lies on the path from the family root to the current Session. */
  readonly onPath: boolean
  /**
   * Guide lines by level, outermost first, one entry per ancestor level: whether
   * the row at the next level on this row's path, this row itself for the last
   * entry, has a later sibling, so that level's guide continues below this row.
   */
  readonly rails: readonly boolean[]
}

/** One Session in the family. */
export interface LoomSessionRow extends LoomRowBase {
  readonly kind: 'session'
  readonly sessionId: SessionId
  /** List display title, verbatim. */
  readonly title: string
  /** Turns and steps this Session ran itself; absent before `sessionStats` arrives. */
  readonly turns?: number
  readonly steps?: number
  /** Own total tokens; absent before `tokenUsage` arrives. */
  readonly tokens?: number
  readonly status: LoomRowStatus
  /** Whether this row is the Session the Loom tab belongs to. */
  readonly current: boolean
  /** Private mark the Session shows, or null. */
  readonly mark: LoomMark | null
  /** Whether the user adopted this branch as the main line. */
  readonly adopted: boolean
  /** Last turn the Session opened, from its outline; absent before the outline arrives or without turns. */
  readonly lastTurn?: number
}

/** One cut of a parent Session that its child rows were forked at. */
export interface LoomPointRow extends LoomRowBase {
  readonly kind: 'point'
  /** Session whose cut this point is. */
  readonly parentSessionId: SessionId
  /** Cut seq; absent for children whose lineage has not arrived. */
  readonly cutSeq?: SessionSeq
  /** Last inherited turn; absent for a cut inside the first turn or an unknown cut. */
  readonly cutTurn?: number
  /** Last parent turn opened before the cut; later than `cutTurn` for a cut inside a turn. Absent until the parent's outline arrives. */
  readonly openedTurn?: number
  /** Number of child Sessions at this cut. */
  readonly branchCount: number
  /** Sum of the children's own tokens; absent while no child reports usage. */
  readonly tokens?: number
  /** Number of children at this cut that are running. */
  readonly running: number
}

/** One visible tree row. */
export type LoomTreeRow = LoomSessionRow | LoomPointRow

/** Inputs of {@link buildLoomTree}. */
export interface LoomTreeInput {
  readonly family: LoomFamily
  readonly list: SessionListState
  /** Session the Loom tab belongs to. */
  readonly currentSessionId: SessionId
  /** Live running state by Session; a Session absent here falls back to its family node. */
  readonly running: (sessionId: SessionId) => boolean | undefined
  /** Row ids the user collapsed; every other expandable row is expanded. */
  readonly collapsed: ReadonlySet<string>
  /** Marks this browser is saving, by Session. */
  readonly marks: Readonly<Record<SessionId, LoomMarkOverride>>
}

/** Visible rows and the family size. */
export interface LoomTree {
  readonly rows: readonly LoomTreeRow[]
  /** Number of Sessions in the family, visible or not. */
  readonly sessionCount: number
}

/**
 * Row id of one Session.
 * @param sessionId - Session the row represents.
 * @returns the row id.
 */
export function sessionRowId(sessionId: SessionId): string {
  return `s:${sessionId}`
}

/** A cut's group of child nodes under one parent. */
interface PointGroup {
  readonly id: string
  readonly cutSeq?: SessionSeq
  readonly cutTurn?: number
  readonly openedTurn?: number
  readonly children: LoomFamilyNode[]
}

/** Order known cuts by seq and put the group of unknown cuts last. */
function byCut(left: PointGroup, right: PointGroup): number {
  return (left.cutSeq ?? Number.POSITIVE_INFINITY) - (right.cutSeq ?? Number.POSITIVE_INFINITY)
}

/**
 * Build the visible outline of one fork family.
 * @param input - family, list, current Session, live status, and collapsed rows.
 * @returns visible rows in document order and the family size.
 */
export function buildLoomTree(input: LoomTreeInput): LoomTree {
  const { family, list, currentSessionId, running, collapsed, marks } = input
  const childrenOf = new Map<string, LoomFamilyNode[]>()
  for (const node of family.nodes) {
    if (node.parentId === undefined) continue
    const siblings = childrenOf.get(node.parentId)
    if (siblings === undefined) childrenOf.set(node.parentId, [node])
    else siblings.push(node)
  }
  const pointsOf = (node: LoomFamilyNode): PointGroup[] => {
    const groups = new Map<string, PointGroup>()
    const parentValues = projectionValuesOf(list, node.sessionId)
    for (const child of childrenOf.get(node.id) ?? []) {
      const cut = forkCutOf(list, child.sessionId)
      const id = `p:${node.sessionId}:${cut === undefined ? '?' : String(cut.cutSeq)}`
      let group = groups.get(id)
      if (group === undefined) {
        const openedTurn = cut === undefined ? undefined : openedTurnAt(parentValues, cut.cutSeq)
        group = cut === undefined
          ? { id, children: [] }
          : {
            id,
            cutSeq: cut.cutSeq,
            ...cut.cutTurn === undefined ? {} : { cutTurn: cut.cutTurn },
            ...openedTurn === undefined ? {} : { openedTurn },
            children: [],
          }
        groups.set(id, group)
      }
      group.children.push(child)
    }
    return [...groups.values()].sort(byCut)
  }
  const path = new Set<string>()
  const byId = new Map(family.nodes.map(node => [node.id, node]))
  for (let node = family.nodes.find(candidate => candidate.sessionId === currentSessionId); node !== undefined;) {
    path.add(sessionRowId(node.sessionId))
    const parent = node.parentId === undefined ? undefined : byId.get(node.parentId)
    if (parent !== undefined) {
      const cut = forkCutOf(list, node.sessionId)
      path.add(`p:${parent.sessionId}:${cut === undefined ? '?' : String(cut.cutSeq)}`)
    }
    node = parent
  }

  const rows: LoomTreeRow[] = []
  const isRunning = (node: LoomFamilyNode): boolean => running(node.sessionId) ?? node.running
  const tokensOf = (sessionId: SessionId): number | undefined => ownTokens(projectionValuesOf(list, sessionId))
  const visitSession = (
    node: LoomFamilyNode,
    level: number,
    position: Pick<LoomRowBase, 'posinset' | 'setsize'>,
    rails: readonly boolean[],
    parentRowId?: string,
  ): void => {
    const id = sessionRowId(node.sessionId)
    const points = pointsOf(node)
    const expanded = points.length > 0 && !collapsed.has(id)
    const values = projectionValuesOf(list, node.sessionId)
    const counts = ownCounts(values)
    const tokens = tokensOf(node.sessionId)
    const live = isRunning(node)
    const lastTurn = values?.turnOutline?.at(-1)?.turn
    rows.push({
      kind: 'session',
      id,
      level,
      ...parentRowId === undefined ? {} : { parentRowId },
      ...position,
      expandable: points.length > 0,
      expanded,
      onPath: path.has(id),
      rails,
      sessionId: node.sessionId,
      title: sessionTitle(list, node.sessionId),
      ...counts === undefined ? {} : { turns: counts.turns, steps: counts.steps },
      ...tokens === undefined ? {} : { tokens },
      // A fork that never ran a turn of its own has not ended anything.
      status: live ? 'running' : node.blank || counts?.turns === 0 ? 'blank' : 'done',
      current: node.sessionId === currentSessionId,
      mark: markOf(values?.loomMark, marks[node.sessionId]),
      adopted: branchOf(values)?.adopted === true,
      ...lastTurn === undefined ? {} : { lastTurn },
    })
    if (!expanded) return
    points.forEach((point, index) => {
      const pointExpanded = !collapsed.has(point.id)
      const pointRails = [...rails, index < points.length - 1]
      const known = point.children.map(child => tokensOf(child.sessionId)).filter(value => value !== undefined)
      rows.push({
        kind: 'point',
        id: point.id,
        parentSessionId: node.sessionId,
        level: level + 1,
        parentRowId: id,
        posinset: index + 1,
        setsize: points.length,
        expandable: true,
        expanded: pointExpanded,
        onPath: path.has(point.id),
        rails: pointRails,
        ...point.cutSeq === undefined ? {} : { cutSeq: point.cutSeq },
        ...point.cutTurn === undefined ? {} : { cutTurn: point.cutTurn },
        ...point.openedTurn === undefined ? {} : { openedTurn: point.openedTurn },
        branchCount: point.children.length,
        ...known.length === 0 ? {} : { tokens: known.reduce((sum, value) => sum + value, 0) },
        running: point.children.filter(isRunning).length,
      })
      if (!pointExpanded) return
      point.children.forEach((child, childIndex) => {
        const childRails = [...pointRails, childIndex < point.children.length - 1]
        visitSession(child, level + 2, { posinset: childIndex + 1, setsize: point.children.length }, childRails, point.id)
      })
    })
  }
  const root = byId.get(family.rootId)
  if (root !== undefined) visitSession(root, 1, { posinset: 1, setsize: 1 }, [])
  return { rows, sessionCount: family.nodes.length }
}
