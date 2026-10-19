/** Retained prose requests in their recorded creation order. */
import type { LoomPrefixSpan, LoomWeaveNode } from '@deepseek-ai/dsh-experimental-loom/types'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Siblings produced by one exact prose request. */
export interface WeaveSet {
  requestSeq: SessionSeq
  prefix: readonly LoomPrefixSpan[]
  nodes: LoomWeaveNode[]
}

/**
 * Group every recorded prose continuation, including unchosen and ancestor requests.
 * @param nodes - settled nodes in recorded order, including auxiliary probe nodes.
 * @returns one group per prose request, preserving its exact prefix and node order.
 */
export function weaveSets(nodes: readonly LoomWeaveNode[]): WeaveSet[] {
  const groups = new Map<SessionSeq, WeaveSet>()
  for (const node of nodes) {
    if (node.kind !== 'weave') continue
    let group = groups.get(node.requestSeq)
    if (group === undefined) {
      group = { requestSeq: node.requestSeq, prefix: node.prefix, nodes: [] }
      groups.set(node.requestSeq, group)
    }
    group.nodes.push(node)
  }
  return [...groups.values()]
}
