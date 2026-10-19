/** Locale-owned reading of an estimate: dollars at list price, tokens without one, never zero dollars for an unpriced route. */
import { describe, expect, it } from 'vitest'
import { costReading } from '../src/client/cost.ts'
import { tEn, tZh } from './fixtures.client.ts'

describe('costReading', () => {
  it('reads a priced estimate as a per-branch range, the total for several, and the cache share', () => {
    expect(costReading({ priced: true, perBranch: { low: 0.006, high: 0.01 }, total: { low: 0.03, high: 0.05 }, cacheShare: 0.887, basis: 'family' }, 5, tEn))
      .toEqual({
        first: '≈ $0.006–$0.010 per branch · list price',
        second: "≈ $0.030–$0.050 for 5 · 88% of input was cached across this family's own turns",
      })
    expect(costReading({ priced: true, perBranch: { low: 0.008, high: 0.008 }, total: { low: 0.008, high: 0.008 }, cacheShare: 0.4, basis: 'own-turn' }, 1, tZh))
      .toEqual({ first: '每个分支 ≈ $0.008 · 标价', second: '本轮自身运行中 40% 的输入命中缓存' })
  })

  it('reads an unpriced estimate in tokens and says no price is configured', () => {
    expect(costReading({ priced: false, perBranch: { low: 12_400, high: 19_000 }, total: { low: 24_800, high: 38_000 }, cacheShare: 0, basis: 'own-turn' }, 2, tEn))
      .toEqual({ first: '≈ 12.4K–19K tokens per branch · no list price for this route', second: '≈ 24.8K–38K tokens for 2' })
  })

  it('has no second line without a total for several or a cache share, and nothing without a per-branch figure', () => {
    expect(costReading({ priced: true, perBranch: { low: 2, high: 3 }, total: { low: 4, high: 6 }, cacheShare: 0, basis: 'family' }, 1, tEn))
      .toEqual({ first: '≈ $2.00–$3.00 per branch · list price' })
    expect(costReading({ priced: true, perBranch: { low: 0, high: 0.0004 }, cacheShare: 0, basis: 'family' }, 3, tEn))
      .toEqual({ first: '≈ $0–<$0.001 per branch · list price' })
    expect(costReading({ priced: false, cacheShare: 0.5, basis: 'family' }, 2, tEn)).toBeUndefined()
  })
})
