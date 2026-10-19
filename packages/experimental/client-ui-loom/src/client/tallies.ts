/**
 * Pure tallies of prompt-variant sets for the Loom tab: for each branch point
 * whose children came from a `variants` request, each prompt line with its
 * samples and how many of them the user kept or set aside. Only the point's
 * own children count, so a grandchild that inherited a branch record is never
 * counted twice.
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { LoomBranchView, LoomFamily, LoomFamilyNode, LoomSetId } from '@deepseek-ai/dsh-experimental-loom/types'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { LoomMarkOverride } from './branching.ts'
import { branchOf, forkCutOf, markOf, openedTurnAt, projectionValuesOf } from './lineage.ts'

/** One prompt line of a variant set. */
export interface LoomVariantTally {
  /** Digest the Host gave every sample of the line. */
  readonly variantKey: string
  /** One-based line position within its set. */
  readonly position: number
  /** The line's prompt preview from a sample's outline; empty until one arrives. */
  readonly prompt: string
  readonly samples: number
  readonly kept: number
  readonly setAside: number
}

/** The variant sets forked at one cut. */
export interface LoomPointTallies {
  /** Tree row id of the branch point. */
  readonly pointId: string
  readonly cutSeq: SessionSeq
  readonly cutTurn?: number
  /** Last parent turn opened before the cut, when the parent's outline has arrived. */
  readonly openedTurn?: number
  /** One entry per set, in creation order. */
  readonly sets: readonly { readonly setId: LoomSetId; readonly lines: readonly LoomVariantTally[] }[]
}

/**
 * Read the prompt a child sent first after its cut.
 * @param list - client Session list.
 * @param sessionId - child Session.
 * @param cutSeq - the child's cut.
 * @returns the bounded preview, or an empty string before the outline arrives.
 */
function firstOwnPrompt(list: SessionListState, sessionId: SessionId, cutSeq: SessionSeq): string {
  return projectionValuesOf(list, sessionId)?.turnOutline?.find(entry => entry.seq > cutSeq)?.prompt ?? ''
}

/**
 * Tally every prompt-variant set in a family.
 * @param family - the fork family.
 * @param list - client Session list with each member's projections.
 * @param marks - marks this browser is saving, by Session.
 * @returns one entry per branch point with variant sets, in family order.
 */
export function variantTallies(
  family: LoomFamily,
  list: SessionListState,
  marks: Readonly<Record<SessionId, LoomMarkOverride>>,
): readonly LoomPointTallies[] {
  const byId = new Map(family.nodes.map(node => [node.id, node]))
  const points = new Map<string, {
    parent: LoomFamilyNode
    cutSeq: SessionSeq
    cutTurn?: number
    children: { readonly node: LoomFamilyNode; readonly branch: LoomBranchView; readonly variantKey: string }[]
  }>()
  for (const node of family.nodes) {
    const parent = node.parentId === undefined ? undefined : byId.get(node.parentId)
    const cut = forkCutOf(list, node.sessionId)
    const branch = branchOf(projectionValuesOf(list, node.sessionId))
    if (parent === undefined || cut === undefined || branch?.kind !== 'variants' || branch.variantKey === undefined) continue
    const pointId = `p:${parent.sessionId}:${String(cut.cutSeq)}`
    const child = { node, branch, variantKey: branch.variantKey }
    const point = points.get(pointId)
    if (point === undefined) {
      points.set(pointId, { parent, cutSeq: cut.cutSeq, ...cut.cutTurn === undefined ? {} : { cutTurn: cut.cutTurn }, children: [child] })
    } else point.children.push(child)
  }
  return [...points].map(([pointId, point]) => {
    const sets = new Map<LoomSetId, Map<string, { first: number; prompt: string; samples: number; kept: number; setAside: number }>>()
    for (const { node: child, branch, variantKey: key } of point.children) {
      const values = projectionValuesOf(list, child.sessionId)
      let lines = sets.get(branch.setId)
      if (lines === undefined) {
        lines = new Map()
        sets.set(branch.setId, lines)
      }
      const line = lines.get(key) ?? { first: branch.index, prompt: '', samples: 0, kept: 0, setAside: 0 }
      const mark = markOf(values?.loomMark, marks[child.sessionId])
      lines.set(key, {
        first: Math.min(line.first, branch.index),
        prompt: line.prompt === '' ? firstOwnPrompt(list, child.sessionId, point.cutSeq) : line.prompt,
        samples: line.samples + 1,
        kept: line.kept + (mark === 'keep' ? 1 : 0),
        setAside: line.setAside + (mark === 'set-aside' ? 1 : 0),
      })
    }
    const openedTurn = openedTurnAt(projectionValuesOf(list, point.parent.sessionId), point.cutSeq)
    return {
      pointId,
      cutSeq: point.cutSeq,
      ...point.cutTurn === undefined ? {} : { cutTurn: point.cutTurn },
      ...openedTurn === undefined ? {} : { openedTurn },
      sets: [...sets].map(([setId, lines]) => ({
        setId,
        lines: [...lines]
          .sort(([, left], [, right]) => left.first - right.first)
          .map(([variantKey, line], index) => ({
            variantKey, position: index + 1, prompt: line.prompt, samples: line.samples, kept: line.kept, setAside: line.setAside,
          })),
      })),
    }
  })
}
