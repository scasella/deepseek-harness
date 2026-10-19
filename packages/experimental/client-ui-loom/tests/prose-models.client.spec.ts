/** Historical prose sets, prefix capture, actionable refusals, and probability geometry retain recorded facts. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LoomNodeId, LoomProbeNode, LoomProbeValue, LoomWeaveNode } from '@deepseek-ai/dsh-experimental-loom/types'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { weaveSets } from '../src/client/weave-sets.ts'
import { capturedPrefix } from '../src/client/captured-prefix.ts'
import { proseFailureKey } from '../src/client/prose-failure.ts'
import { probeAncestors, probeGeometry } from '../src/client/probe-layout.ts'
const N = brandString<LoomNodeId>('n'), A = brandString<LoomProbeNode['id']>('a'), B = brandString<LoomProbeNode['id']>('b'), C = brandString<LoomProbeNode['id']>('c')
const nodes: LoomProbeNode[] = [
  { id: A, parent: null, sourceNodeId: N, tokenIndex: 0, token: 'air', probability: .4, cumulativeProbability: .4, depth: 1 },
  { id: B, parent: null, sourceNodeId: N, tokenIndex: 0, token: 'sea', probability: .3, cumulativeProbability: .3, depth: 1 },
  { id: C, parent: A, sourceNodeId: N, tokenIndex: 0, token: ' below', probability: .5, cumulativeProbability: .2, depth: 2 },
]
describe('recorded prose models', () => {
  it('keeps every unchosen request, excludes probes, and preserves exact prefix references', () => {
    const node: LoomWeaveNode = { id: N, parent: null, kind: 'weave', requestSeq: SessionSeq(1), index: 0, prefix: [{ text: 'x', author: 'user' }], text: 'a', status: 'completed' }
    const sets = weaveSets([node, { ...node, index: 1 }, { ...node, requestSeq: SessionSeq(2) }, { ...node, kind: 'probe' }])
    expect(sets.map(set => set.nodes.length)).toEqual([2, 1]); expect(sets[0]!.prefix).toBe(node.prefix)
  })
  it('keeps whole captured tokens before a cursor and leaves a partial last token unmarked', () => {
    const p = { tokens: ['air', ' below'], logprobs: [-1, -2], top: [[], []] }
    expect(capturedPrefix('air below', p)).toBe(p)
    expect(capturedPrefix('else', p)).toBeUndefined()
    expect(capturedPrefix('air', p)).toEqual({ tokens: ['air'], logprobs: [-1], top: [[]] })
    expect(capturedPrefix('air be', p)).toEqual({ tokens: ['air', ' be'], logprobs: [-1, null], top: [[], []] })
  })
  it('classifies typed recovery actions and leaves unknown diagnostics out of product copy', () => {
    expect(proseFailureKey()).toBe('weave.failed')
    expect(proseFailureKey({ code: 'remote-access/denied' })).toBe('prose.denied')
    expect(proseFailureKey({ code: 'session/not-found' })).toBe('prose.denied')
    expect(proseFailureKey({ code: 'session/agent-busy' })).toBe('prose.busy')
    expect(proseFailureKey({ code: 'x', details: null })).toBe('weave.failed')
    expect(proseFailureKey({ code: 'x', details: {} })).toBe('weave.failed')
    expect(proseFailureKey({ code: 'x', details: { reasonCode: 1 } })).toBe('weave.failed')
    for (const reasonCode of ['unsupported-prefix', 'unsupported-logprobs', 'limits', 'prefix', 'route', 'busy', 'provider', 'cancelled', 'future']) {
      expect(proseFailureKey({ code: 'loom/prose-unavailable', details: { reasonCode } })).toMatch(/^(prose\.|weave.failed)/)
    }
  })
  it('groups children inside parent intervals, hatches only observed residuals, and magnifies a selected path', () => {
    const value: LoomProbeValue = { nodes, requests: 2, truncated: true }
    expect(probeAncestors(value, nodes[2]!)).toEqual([nodes[0], nodes[2]])
    const graph = probeGeometry(value)
    expect(graph.rectangles.find(rect => rect.node?.id === B)).toMatchObject({ top: .4, mass: .3 })
    expect(graph.rectangles.find(rect => rect.node?.id === C)).toMatchObject({ top: 0, mass: .2, depth: 1 })
    expect(graph.rectangles.some(rect => rect.node === undefined && rect.top === .4)).toBe(false)
    const known = probeGeometry({ ...value, positions: [{ parent: null, sourceNodeId: N }, { parent: B, sourceNodeId: N }] })
    expect(known.rectangles).toContainEqual({ depth: 1, top: .4, mass: .29999999999999993 })
    const zoom = probeGeometry(value, nodes[0]); expect(zoom.scale).toBe(.4)
    expect(zoom.rectangles[0]).toMatchObject({ top: 0, mass: .4, depth: 0 })
    expect(probeGeometry({ nodes: [], requests: 0, truncated: false }).rectangles).toEqual([])
    expect(probeGeometry({ nodes: [], requests: 1, truncated: false }).rectangles).toEqual([{ depth: 0, top: 0, mass: 1 }])
  })
})
