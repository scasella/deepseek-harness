// @vitest-environment jsdom
/** Prose estimates identify their historical input evidence, exact prefix, and requested output cap. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { WeaveCost } from '../src/client/WeaveCost.tsx'
import type { LoomViewProps } from '../src/client/LoomView.tsx'
import { tEn } from './fixtures.client.ts'
afterEach(cleanup)
describe('prose estimate reading', () => {
  it('names historical input and the output cap for matching and different prefixes', () => {
    let value = { priced: false, perBranch: { low: 10, high: 20 }, cacheShare: .5, basis: 'weave-history' as const,
      historicalInput: { requestSeq: SessionSeq(1), samples: 2, provider: 'p', model: 'm', prefixMatches: true }, outputCap: 70 }
    const read = vi.fn((_key: string) => ({ status: 'ready' as const, value, refreshing: false, stale: false }))
    const props = { sessionId: SessionId('s'), n: 2, maxTokens: 70, prefix: [], selection: { provider: 'p', model: 'm' }, useLoomEstimate: ((key: string): unknown => read(key)) as LoomViewProps['useLoomEstimate'], t: tEn }
    const b = render(<dl><WeaveCost {...props} /></dl>)
    expect(screen.getByText(/Historical input.*continuations: 2.*same cursor text/)).toBeTruthy()
    expect(screen.getByText(/50% of historical prose input was cached/)).toBeTruthy()
    value = { ...value, historicalInput: { ...value.historicalInput, prefixMatches: false } }; b.rerender(<dl><WeaveCost {...props} /></dl>)
    expect(screen.getByText(/different cursor text; cost may differ/)).toBeTruthy()
    expect(read.mock.lastCall![0]).toContain('weave')
  })
})
