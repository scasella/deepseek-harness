/** Configured list prices of provider routes and the cost of a token count at one of them. */
import type { Context } from '@deepseek-ai/cordis'
import type { TokenUsageBuckets } from '@deepseek-ai/dsh-token-meter/client'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { lastAssistantStreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { isSettlement, routeOfHeader } from './route.ts'
import type { LoomPriceRow, LoomPriceUsageState } from './types.ts'

/** Numeric fields of a price row, in the order a diagnostic checks them. */
const PRICE_FIELDS = ['inputMissPerMTok', 'inputHitPerMTok', 'outputPerMTok'] as const

/**
 * Key of one route in the compiled price table.
 * @param provider - registered provider route.
 * @param model - provider-owned model id.
 * @returns the key.
 */
export function priceKey(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

/**
 * Validate the configured price rows and index them by route.
 * @param rows - `pricing` as configured.
 * @returns each route's row.
 * @throws Error naming the row for an empty provider or model, a price that is not a finite number of at least 0,
 *   or a route that two rows price; the plugin then fails to load.
 */
export function compilePricing(rows: readonly LoomPriceRow[]): ReadonlyMap<string, LoomPriceRow> {
  const prices = new Map<string, LoomPriceRow>()
  for (const [index, row] of rows.entries()) {
    if (row.provider.trim().length === 0 || row.model.trim().length === 0) {
      throw new Error(`loom: pricing[${String(index)}] must name a provider and a model`)
    }
    for (const field of PRICE_FIELDS) {
      if (!Number.isFinite(row[field]) || row[field] < 0) {
        throw new Error(`loom: pricing[${String(index)}].${field} must be a finite number of at least 0`)
      }
    }
    const key = priceKey(row.provider, row.model)
    if (prices.has(key)) {
      throw new Error(`loom: pricing[${String(index)}] prices route "${row.provider}/${row.model}" a second time`)
    }
    prices.set(key, row)
  }
  return prices
}

/** Tokens per million, the unit of every configured price. */
const TOKENS_PER_MTOK = 1_000_000

/**
 * List-price cost of token counts on one route. Cache reads cost the hit
 * price; uncached input and cache writes cost the miss price, because a row
 * has no separate write price; output, reasoning tokens included, costs the
 * output price.
 * @param row - the route's configured prices.
 * @param usage - provider-reported token buckets, such as a Session's `tokenUsage` own totals.
 * @returns US dollars.
 */
export function priceOf(row: LoomPriceRow, usage: TokenUsageBuckets): number {
  const hit = usage.cacheReadTokens * row.inputHitPerMTok
  const miss = (usage.uncachedInputTokens + usage.cacheWriteTokens) * row.inputMissPerMTok
  return (hit + miss + usage.outputTokens * row.outputPerMTok) / TOKENS_PER_MTOK
}

/**
 * Usage of one billed request, including a failed attempt's final usage chunk.
 * @param event - the request settlement.
 * @returns reported usage, or undefined when the provider reported none.
 */
export function settlementUsage(event: SessionEvent<'assistant/message'> | SessionEvent<'assistant/attempt'>): TokenUsage | undefined {
  return (event.type === 'assistant/message' ? event.data.usage : undefined)
    ?? lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
}

/**
 * Add request usage to its logged route; inherited headers select routes but inherited settlements add no usage.
 * @param state - usage totals through the prior event.
 * @param event - next event.
 * @returns updated totals, or the same state when the event adds nothing.
 */
function foldUsage(state: LoomPriceUsageState, event: SessionEvent): LoomPriceUsageState {
  if (event.type === 'request/header') {
    const { provider, model } = routeOfHeader(event.data.header)
    return { ...state, route: { provider, model } }
  }
  if (event.seq < state.inheritedEventCount || !isSettlement(event)) return state
  const usage = settlementUsage(event)
  if (state.route === null || usage === undefined) return { ...state, incomplete: true }
  const { provider, model } = state.route
  const previous = state.routes.find(row => row.provider === provider && row.model === model)
  const next = {
    provider,
    model,
    uncachedInputTokens: (previous?.uncachedInputTokens ?? 0) + usage.inputTokens,
    cacheReadTokens: (previous?.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: (previous?.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
  }
  const routes = previous === undefined ? [...state.routes, next] : state.routes.map(row => row === previous ? next : row)
  return { ...state, routes }
}

/**
 * Price each route's own usage; a missing route or sample makes the whole total unavailable.
 * @param state - usage totals.
 * @param prices - configured list prices.
 * @returns USD, or undefined when an own request cannot be priced.
 */
function usageCost(state: LoomPriceUsageState, prices: ReadonlyMap<string, LoomPriceRow>): number | undefined {
  if (state.incomplete) return undefined
  let amount = 0
  for (const usage of state.routes) {
    const row = prices.get(priceKey(usage.provider, usage.model))
    if (row === undefined) return undefined
    amount += priceOf(row, usage)
  }
  if (state.routes.length > 0) return amount
  return state.route !== null && prices.has(priceKey(state.route.provider, state.route.model)) ? 0 : undefined
}

/**
 * List-price total of every own request, using each request's logged route and reported usage.
 * @param events - complete Session log.
 * @param inheritedEventCount - fork-inherited prefix length.
 * @param prices - configured route prices.
 * @returns dollars, or undefined when any own settlement has no usage or price.
 */
export function ownCost(
  events: readonly SessionEvent[],
  inheritedEventCount: number,
  prices: ReadonlyMap<string, LoomPriceRow>,
): number | undefined {
  let state: LoomPriceUsageState = { inheritedEventCount, route: null, routes: [], incomplete: false }
  for (const event of events) state = foldUsage(state, event)
  return usageCost(state, prices)
}

const routeSchema = z.object({ provider: z.string(), model: z.string() }).strict()
const usageStateSchema: z.ZodType<LoomPriceUsageState> = z.object({
  inheritedEventCount: z.number().int().nonnegative(),
  route: routeSchema.nullable(),
  incomplete: z.boolean(),
  routes: z.array(routeSchema.extend({
    uncachedInputTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative(),
    cacheWriteTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
  }).strict()),
}).strict()

/** Host-only per-route usage; storing tokens keeps restored checkpoints independent of configured prices. */
export const loomPriceUsageProjection = {
  key: 'loomPriceUsage',
  stateVersion: 1,
  stateSchema: usageStateSchema,
  init: (_header, inheritedEventCount) => ({ inheritedEventCount, route: null, routes: [], incomplete: false }),
  apply: foldUsage,
} satisfies ProjectionDefinition<'loomPriceUsage', LoomPriceUsageState>

/** Synchronous Host pricing reads over the registered usage projection. */
export class LoomPricing {
  /**
   * @param ctx - Loom context carrying the required projection registry.
   * @param prices - validated list prices, fixed for this plugin lifetime.
   */
  constructor(private readonly ctx: Context, private readonly prices: ReadonlyMap<string, LoomPriceRow>) {
    ctx.sessionProjections.register(loomPriceUsageProjection)
  }

  /**
   * Price a live Session's own usage without activating or reading persistence.
   * @param session - live Session.
   * @returns USD, or undefined when an own request lacks usage or prices, or no priced route is logged yet.
   * @throws Error when the owning usage projection is no longer registered.
   */
  ownUsd(session: Session): number | undefined {
    const state = this.ctx.sessionProjections.stateOf(session, 'loomPriceUsage')
    if (state === undefined) throw new Error('loom: ownUsd requires the loomPriceUsage projection')
    return usageCost(state, this.prices)
  }
}
