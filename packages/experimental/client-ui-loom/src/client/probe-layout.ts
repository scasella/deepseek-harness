/** Probability geometry from recorded token paths; missing expansion is never treated as zero probability. */
import type { LoomProbeNode, LoomProbeValue } from '@deepseek-ai/dsh-experimental-loom/types'

/** A probability rectangle, in units of the original path distribution. */
export interface ProbeRectangle {
  depth: number
  top: number
  mass: number
  node?: LoomProbeNode
}

/** Geometry of one complete distribution or a selected subtree. */
export interface ProbeGeometry {
  scale: number
  columns: number
  rectangles: ProbeRectangle[]
}

/**
 * Read a recorded path from its first token through the selected token.
 * @param value - captured exploration.
 * @param node - last selected token.
 * @returns ancestor tokens in provider order.
 */
export function probeAncestors(value: LoomProbeValue, node: LoomProbeNode): LoomProbeNode[] {
  const path: LoomProbeNode[] = []
  let next: LoomProbeNode | undefined = node
  while (next !== undefined) {
    path.unshift(next)
    const parent: LoomProbeNode['parent'] = next.parent
    next = parent === null ? undefined : value.nodes.find(candidate => candidate.id === parent)
  }
  return path
}

/**
 * Position child rectangles inside their parent's probability interval.
 * @param value - recorded alternatives and positions actually probed.
 * @param root - optional selected token whose subtree is magnified to the whole plot.
 * @returns proportional rectangles; hatching covers unshown mass only at known probed positions.
 */
export function probeGeometry(value: LoomProbeValue, root?: LoomProbeNode): ProbeGeometry {
  const rectangles: ProbeRectangle[] = []
  const scale = root?.cumulativeProbability ?? 1
  const visit = (parent: LoomProbeNode | undefined, top: number, depth: number): void => {
    const parentId = parent?.id ?? null
    const mass = parent?.cumulativeProbability ?? 1
    const children = value.nodes.filter(node => node.parent === parentId)
    let nextTop = top
    for (const node of children) {
      rectangles.push({ depth, top: nextTop, mass: node.cumulativeProbability, node })
      visit(node, nextTop, depth + 1)
      nextTop += node.cumulativeProbability
    }
    const probed = value.positions?.some(position => position.parent === parentId)
      ?? (children.length > 0 || parent === undefined && value.requests > 0)
    const unshown = Math.max(0, top + mass - nextTop)
    if (probed && unshown > 0) rectangles.push({ depth, top: nextTop, mass: unshown })
  }
  if (root !== undefined) rectangles.push({ depth: 0, top: 0, mass: scale, node: root })
  visit(root, 0, root === undefined ? 0 : 1)
  return { scale, columns: Math.max(1, ...rectangles.map(rectangle => rectangle.depth + 1)), rectangles }
}
