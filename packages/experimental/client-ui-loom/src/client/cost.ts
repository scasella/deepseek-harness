/**
 * Locale-owned reading of a `loom.estimate` result for the Cost rows of the
 * Regenerate panel and the Branch ×N form. A priced estimate reads in dollars
 * at the route's list price; an unpriced one reads in own tokens and says no
 * price is configured. It never reads an unpriced estimate as zero dollars.
 */
import { compactTokens, rangeText, usdText, type LoomTranslate } from './format.ts'
import type { LoomEstimateValue } from '@deepseek-ai/dsh-experimental-loom/types'

/** The lines of one Cost row. */
export interface CostReading {
  /** The per-branch figure. */
  readonly first: string
  /** The total for several branches and the cache share, when there are any. */
  readonly second?: string
}

/**
 * Read an estimate.
 * @param estimate - the Host's estimate.
 * @param count - branches the request would create.
 * @param t - Loom translate seat.
 * @returns the lines, or undefined when the estimate carries no per-branch figure.
 */
export function costReading(estimate: LoomEstimateValue, count: number, t: LoomTranslate): CostReading | undefined {
  const { perBranch, total, priced } = estimate
  if (perBranch === undefined) return undefined
  const format = priced ? (value: number) => usdText(value, t) : (value: number) => compactTokens(Math.round(value), t)
  const percent = Math.floor(estimate.cacheShare * 100)
  const parts = [
    total === undefined || count < 2
      ? undefined
      : t(priced ? 'cost.total' : 'cost.totalTokens', { range: rangeText(total.low, total.high, format, t), count }),
    percent > 0 ? t(estimate.basis === 'own-turn' ? 'cost.cache.ownTurn' : estimate.basis === 'weave-history' ? 'cost.cache.weave' : 'cost.cache.family', { percent }) : undefined,
  ].filter(part => part !== undefined)
  return {
    first: t(priced ? 'cost.perBranch' : 'cost.tokens', { range: rangeText(perBranch.low, perBranch.high, format, t) }),
    ...parts.length === 0 ? {} : { second: parts.join(t('sep')) },
  }
}
