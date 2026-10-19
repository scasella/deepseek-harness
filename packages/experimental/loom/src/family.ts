/**
 * Browser-safe fork-family derivation from Session list rows. The Host and the
 * browser map their own list rows into {@link LoomFamilyRow} and share this
 * walk.
 * @module @deepseek-ai/dsh-experimental-loom/family
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LoomFamily, LoomFamilyNode, LoomNodeId } from './types.ts'

/** The list facts of one Session that its fork family reads. */
export interface LoomFamilyRow {
  /** Listed Session. */
  readonly sessionId: SessionId
  /** Fork source; absent for a Session without a parent and for a subagent child, whose parent link is not a fork link. */
  readonly forkParentId?: SessionId
  /** Header creation time from the `forkLineage` list hint; absent when the row carries no such hint. */
  readonly createdAt?: number
  /** Last Session activity in Unix epoch milliseconds. */
  readonly updatedAt: number
  /** Whether the Session's Agent is running. */
  readonly running: boolean
  /** Whether the Session has no turn yet. */
  readonly blank: boolean
}

/**
 * Name the tree node of one Session.
 * @param sessionId - Session the node represents.
 * @returns the node id, whose text is the Session id.
 */
export function loomSessionNode(sessionId: SessionId): LoomNodeId {
  return brandString<LoomNodeId>(sessionId)
}

/** Order siblings by creation, a row without a creation hint after every row with one, then by Session id. */
function bySiblingOrder(left: LoomFamilyRow, right: LoomFamilyRow): number {
  const leftAt = left.createdAt ?? Number.POSITIVE_INFINITY
  const rightAt = right.createdAt ?? Number.POSITIVE_INFINITY
  if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1
  return left.sessionId.localeCompare(right.sessionId)
}

/** Whether two nodes carry the same facts. */
function sameNode(left: LoomFamilyNode, right: LoomFamilyNode): boolean {
  return left.sessionId === right.sessionId && left.parentId === right.parentId && left.depth === right.depth
    && left.createdAt === right.createdAt && left.updatedAt === right.updatedAt
    && left.running === right.running && left.blank === right.blank
}

/**
 * Derive the fork family of one Session from list rows. The walk climbs fork
 * parents while the parent is listed, stops at a repeated Session, and then
 * collects every listed fork descendant of the highest ancestor depth-first,
 * siblings in creation order and then by Session id.
 * @param rows - listed Session rows.
 * @param sessionId - requested family member.
 * @param previous - an earlier result for the same Session; each node whose
 *   facts are unchanged keeps its reference, and an unchanged family returns
 *   `previous` itself.
 * @returns the family, or undefined when `sessionId` is not listed.
 */
export function forkFamily(rows: readonly LoomFamilyRow[], sessionId: SessionId, previous?: LoomFamily): LoomFamily | undefined {
  const byId = new Map(rows.map(row => [row.sessionId, row]))
  const focus = byId.get(sessionId)
  if (focus === undefined) return undefined
  const climbed = new Set<SessionId>([focus.sessionId])
  let root = focus
  for (let parentId = root.forkParentId; parentId !== undefined && !climbed.has(parentId); parentId = root.forkParentId) {
    const parent = byId.get(parentId)
    if (parent === undefined) break
    climbed.add(parentId)
    root = parent
  }
  const children = new Map<SessionId, LoomFamilyRow[]>()
  for (const row of rows) {
    const parentId = row.forkParentId
    if (parentId === undefined || row.sessionId === root.sessionId) continue
    const siblings = children.get(parentId)
    if (siblings === undefined) children.set(parentId, [row])
    else siblings.push(row)
  }
  const earlier = new Map(previous?.nodes.map(node => [node.sessionId, node]))
  const nodes: LoomFamilyNode[] = []
  const placed = new Set<SessionId>()
  const visit = (row: LoomFamilyRow, depth: number, parentId: LoomNodeId | undefined): void => {
    placed.add(row.sessionId)
    const node: LoomFamilyNode = {
      id: loomSessionNode(row.sessionId),
      sessionId: row.sessionId,
      ...parentId === undefined ? {} : { parentId },
      depth,
      ...row.createdAt === undefined ? {} : { createdAt: row.createdAt },
      updatedAt: row.updatedAt,
      running: row.running,
      blank: row.blank,
    }
    const kept = earlier.get(row.sessionId)
    nodes.push(kept !== undefined && sameNode(kept, node) ? kept : node)
    for (const child of [...children.get(row.sessionId) ?? []].sort(bySiblingOrder)) {
      if (!placed.has(child.sessionId)) visit(child, depth + 1, loomSessionNode(row.sessionId))
    }
  }
  visit(root, 0, undefined)
  const rootId = loomSessionNode(root.sessionId)
  const focusId = loomSessionNode(focus.sessionId)
  if (previous?.rootId === rootId && previous.focusId === focusId && previous.nodes.length === nodes.length
    && previous.nodes.every((node, index) => node === nodes[index])) return previous
  return { rootId, focusId, nodes }
}
