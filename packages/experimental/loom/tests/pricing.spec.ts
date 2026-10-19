/** List-price accounting excludes inherited requests and keeps a running Session's route changes. */
import { Context } from '@deepseek-ai/cordis'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, { SessionId, SessionSeq, type EpochHeader, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compilePricing, LoomPricing, ownCost, priceKey, priceOf, settlementUsage } from '../src/pricing.ts'
import type { LoomPriceRow } from '../src/types.ts'

const PRICE: LoomPriceRow = { provider: 'mock', model: 'mock', inputMissPerMTok: 2, inputHitPerMTok: 0.5, outputPerMTok: 4 }
const PRICES = compilePricing([PRICE, { ...PRICE, model: 'other', outputPerMTok: 8 }])
const USAGE: TokenUsage = { inputTokens: 100, cacheWriteTokens: 20, cacheReadTokens: 80, outputTokens: 50 }
const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

function header(model = 'mock', reasoningEffort?: string, adapterDefault = false): EpochHeader {
  return { config: { provider: 'mock', model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }, ...adapterDefault ? { adapterDefaults: { reasoningEffort: true } } : {} } as EpochHeader
}

function log(...entries: readonly Pick<SessionEvent, 'type' | 'data'>[]): SessionEvent[] {
  return entries.map((event, seq) => ({ ...event, seq: SessionSeq(seq), time: seq }) as SessionEvent)
}

function billed(usage: TokenUsage | undefined = USAGE): Pick<SessionEvent, 'type' | 'data'> {
  return { type: 'assistant/attempt', data: { turn: 1, step: 1, stream: usage === undefined ? [] : [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }] } }
}

describe('configured list prices', () => {
  it('ships no prices and rejects empty, duplicate, negative, and nonfinite rows', () => {
    expect(compilePricing([]).size).toBe(0)
    expect(() => compilePricing([{ ...PRICE, provider: '' }])).toThrow('provider and a model')
    expect(() => compilePricing([{ ...PRICE, model: '' }])).toThrow('provider and a model')
    expect(() => compilePricing([PRICE, PRICE])).toThrow('a second time')
    for (const field of ['inputMissPerMTok', 'inputHitPerMTok', 'outputPerMTok']) {
      for (const value of [-1, NaN, Infinity]) expect(() => compilePricing([{ ...PRICE, [field]: value }])).toThrow(field)
    }
    expect(compilePricing([{ ...PRICE, outputPerMTok: 0 }]).get(priceKey('mock', 'mock'))?.outputPerMTok).toBe(0)
    expect(priceOf(PRICE, { uncachedInputTokens: 100, cacheWriteTokens: 20, cacheReadTokens: 80, outputTokens: 50 })).toBeCloseTo(0.00048)
  })

  it('sums each own request at its logged route, including failed attempts, without charging the inherited prefix', () => {
    const events = log(
      { type: 'request/header', data: { reason: 'initial', header: header() } }, billed(),
      billed(),
      { type: 'request/header', data: { reason: 'initial', header: header('other') } }, billed(),
    )
    expect(ownCost(events, 2, PRICES)).toBeCloseTo(0.00116)
    expect(ownCost(events, 0, PRICES)).toBeCloseTo(0.00164)
    expect(ownCost(log(...events, { type: 'request/header', data: { reason: 'change', header: header() } }, billed()), 2, PRICES))
      .toBeCloseTo(0.00164)
    expect(ownCost(events.slice(0, 1), 1, new Map())).toBeUndefined()
    expect(ownCost([], 0, PRICES)).toBeUndefined()
    expect(ownCost(events.slice(0, 1), 1, PRICES)).toBe(0)
    expect(ownCost(log(billed()), 0, PRICES)).toBeUndefined()
    expect(ownCost(events, 2, new Map())).toBeUndefined()
    expect(ownCost(log({ type: 'request/header', data: { reason: 'initial', header: header() } }, { type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [] } }), 0, PRICES)).toBeUndefined()
    expect(ownCost(log({ type: 'request/header', data: { reason: 'initial', header: header() } }, billed({ inputTokens: 1, outputTokens: 1 })), 0, PRICES)).toBeCloseTo(0.000006)
  })

  it('prefers a committed message usage to its stream and otherwise reads the final stream usage', () => {
    const usage = { inputTokens: 1, outputTokens: 2 }
    const event = { type: 'assistant/message', data: { usage, stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: USAGE } }] } } as SessionEvent<'assistant/message'>
    expect(settlementUsage(event)).toBe(usage)
    const { usage: _usage, ...unreported } = event.data
    expect(settlementUsage({ ...event, data: unreported })).toEqual(USAGE)
  })

  it('folds only appended events for a live Session and never charges a fork its inherited requests', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const session = ctx.sessions.create(SessionId('price-live'))
    const pricing = new LoomPricing(ctx, PRICES)
    expect(pricing.ownUsd(session)).toBeUndefined()
    session.append('request/header', { reason: 'initial', header: header() })
    expect(pricing.ownUsd(session)).toBe(0)
    session.append('assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: USAGE } }] })
    expect(pricing.ownUsd(session)).toBeCloseTo(0.00048)
    const state = ctx.sessionProjections.stateOf(session, 'loomPriceUsage')
    expect(pricing.ownUsd(session)).toBeCloseTo(0.00048)
    expect(ctx.sessionProjections.stateOf(session, 'loomPriceUsage')).toBe(state)
    vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValueOnce(undefined)
    expect(() => pricing.ownUsd(session)).toThrow('requires the loomPriceUsage projection')
  })
})
