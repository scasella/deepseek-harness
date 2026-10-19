/** Attribution survives cursor cuts, edits, provider token paths, and persisted rereads. */
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LoomNodeId, LoomPrefixSpan, LoomProbeNode, LoomProbeValue, LoomWeaveNode } from '@deepseek-ai/dsh-experimental-loom/types'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { createLoomProseReads, probePrefix, weaveDocument, weaveParent, weavePrefix } from '../src/client/prose.ts'

const N = brandString<LoomNodeId>('n')
const prefix: readonly LoomPrefixSpan[] = [{ text: 'Human ', author: 'user' }, { text: 'model ', author: 'model', node: N }, { text: 'alternative', author: 'alternative', node: N, tokenIndex: 1 }]
const node: LoomWeaveNode = { id: N, parent: null, requestSeq: SessionSeq(1), index: 0, kind: 'weave', prefix, text: ' ending', status: 'completed' }

describe('prose attribution', () => {
  it('keeps exact authorship through cursor cuts and labels edited suffixes as human text', () => {
    expect(weaveDocument(node)).toEqual([...prefix, { text: ' ending', author: 'model', node: N }])
    expect(weavePrefix('', prefix)).toEqual([])
    expect(weavePrefix('a', [{ text: '', author: 'user' }, { text: 'a', author: 'user' }])).toEqual([{ text: 'a', author: 'user' }])
    expect(weavePrefix('Human model alternative', prefix)).toEqual(prefix)
    expect(weavePrefix('Human mod', prefix)).toEqual([prefix[0], { text: 'mod', author: 'model', node: N }])
    expect(weavePrefix('Human model alt', prefix)).toEqual([prefix[0], prefix[1], { text: 'alt', author: 'user' }])
    expect(weavePrefix('Human model alternative!', prefix)).toEqual([...prefix, { text: '!', author: 'user' }])
    expect(weavePrefix('Edited', prefix)).toEqual([{ text: 'Edited', author: 'user' }])
    expect(weaveParent(prefix)).toBe(N)
    expect(weaveParent([{ text: 'x', author: 'user' }])).toBeNull()
  })

  it('reconstructs a selected explored path in provider order with source references', () => {
    const a = brandString<LoomProbeNode['id']>('a'), b = brandString<LoomProbeNode['id']>('b')
    const value: LoomProbeValue = { requests: 2, truncated: false, nodes: [
      { id: a, parent: null, token: ' first', probability: .5, cumulativeProbability: .5, depth: 1, sourceNodeId: N, tokenIndex: 0 },
      { id: b, parent: a, token: ' second', probability: .4, cumulativeProbability: .2, depth: 2, sourceNodeId: N, tokenIndex: 0 },
    ] }
    expect(probePrefix(value, b, [prefix[0]!])).toEqual([prefix[0],
      { text: ' first', author: 'alternative', node: N, tokenIndex: 0 },
      { text: ' second', author: 'alternative', node: N, tokenIndex: 0 }])
  })

  it('owns persisted reads until the last subscriber leaves and refreshes after choices', async () => {
    const state = { nodes: [node], choices: [], curationBits: 0, modelTokens: 1 }
    const weaveState = vi.fn(async () => ({ ok: true as const, value: state }))
    const reads = createLoomProseReads({ weaveState })
    const source = reads.source('session')
    const stop = source.subscribe(() => {})
    await vi.waitFor(() => { expect(source.getSnapshot()).toMatchObject({ status: 'ready', value: state }) })
    expect(weaveState).toHaveBeenCalledWith({ sessionId: 'session' })
    reads.refresh('session')
    await vi.waitFor(() => { expect(weaveState).toHaveBeenCalledTimes(2) })
    stop(); reads.dispose()
  })
})
