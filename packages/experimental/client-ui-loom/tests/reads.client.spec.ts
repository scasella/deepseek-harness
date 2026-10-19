/** The compare, diff, and estimate sources: each key spells its request, and disposal closes all three. */
import { describe, expect, it, vi } from 'vitest'
import type { LoomEstimateRequest } from '@deepseek-ai/dsh-experimental-loom/types'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { createLoomReads, loomCompareKey, loomDiffKey, loomEstimateKey } from '../src/client/reads.ts'

const A = SessionId('a')

function inputs() {
  return {
    compare: vi.fn(async () => ({ ok: true as const, value: { parent: SessionId('root'), cutSeq: SessionSeq(3), rows: [] } })),
    diff: vi.fn(async () => ({ ok: true as const, value: { unified: 'x', truncated: false } })),
    estimate: vi.fn(async () => ({ ok: true as const, value: { priced: true, cacheShare: 0.5, basis: 'family' as const } })),
  }
}

describe('Loom reads', () => {
  it('reads the compare of the siblings at the keyed Session', () => {
    const calls = inputs()
    const reads = createLoomReads(calls)
    reads.compare.source(loomCompareKey(A)).subscribe(() => {})
    expect(calls.compare).toHaveBeenCalledWith({ sessionId: A })
  })

  it('reads a branch diff whole or of one file, and names the version in the key', () => {
    const calls = inputs()
    const reads = createLoomReads(calls)
    reads.diff.source(loomDiffKey(A, null, '3:1:2')).subscribe(() => {})
    reads.diff.source(loomDiffKey(A, 'src/a b.ts', '3:1:2')).subscribe(() => {})
    expect(calls.diff.mock.calls).toEqual([[{ sessionId: A }], [{ sessionId: A, path: 'src/a b.ts' }]])
    expect(loomDiffKey(A, null, '1')).not.toBe(loomDiffKey(A, null, '2'))
  })

  it('reads an estimate for the turn or the cut the key names', () => {
    const calls = inputs()
    const reads = createLoomReads(calls)
    reads.estimate.source(loomEstimateKey({ sessionId: A, kind: 'regenerate', turn: 2, count: 4 })).subscribe(() => {})
    reads.estimate.source(loomEstimateKey({ sessionId: A, kind: 'variants', afterTurn: 1, count: 6 })).subscribe(() => {})
    expect(calls.estimate.mock.calls).toEqual([
      [{ sessionId: A, kind: 'regenerate', turn: 2, count: 4 }],
      [{ sessionId: A, kind: 'variants', afterTurn: 1, count: 6 }],
    ])
    expect(loomEstimateKey({ sessionId: A, kind: 'steer', afterTurn: 1, count: 2 }))
      .not.toBe(loomEstimateKey({ sessionId: A, kind: 'steer', afterTurn: 1, count: 3 }))
  })

  it('keys estimates by the exact selected provider, model and reasoning effort', () => {
    const calls = inputs(), reads = createLoomReads(calls)
    const request = { sessionId: A, kind: 'regenerate' as const, turn: 2, count: 4, selection: { provider: 'p', model: 'm', reasoningEffort: 'high' as const } }
    reads.estimate.source(loomEstimateKey(request)).subscribe(() => {})
    expect(calls.estimate).toHaveBeenCalledWith(request)
    expect(loomEstimateKey(request)).not.toBe(loomEstimateKey({ ...request, selection: { provider: 'p', model: 'other' } }))
    reads.dispose()
  })

  it('closes the three sources on dispose', () => {
    const calls = inputs()
    const reads = createLoomReads(calls)
    const unobserved = reads.compare.source(loomCompareKey(A))
    unobserved.subscribe(() => {})
    reads.dispose()
    reads.compare.refresh(loomCompareKey(A))
    expect(calls.compare).toHaveBeenCalledOnce()
  })
})

it('round trips prose prefix, route, and output cap without changing branch estimate keys', () => {
  const calls = inputs(), reads = createLoomReads(calls)
  const requests: readonly LoomEstimateRequest[] = [
    { sessionId: A, kind: 'weave' as const, count: 2, maxTokens: 80, prefix: [{ text: 'air', author: 'user' as const }], selection: { provider: 'p', model: 'm' } },
    { sessionId: A, kind: 'weave' as const, count: 1 },
  ]
  for (const request of requests) {
    reads.estimate.source(loomEstimateKey(request)).subscribe(() => {})
    expect(calls.estimate).toHaveBeenLastCalledWith(request)
  }
  reads.dispose()
})
