/** Pure preview arithmetic and request-route reads over recorded settlements. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type EpochHeader, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { resolveEstimate } from '../src/branch-spec.ts'
import { estimateValue, familyBasis, turnBasis } from '../src/estimate.ts'
import { headerRouteAt, nextRouteAt, ownRoute, routeOfHeader, sameRoute } from '../src/route.ts'
import type { LoomEstimateRequest, LoomPriceRow } from '../src/types.ts'

const ID = SessionId('estimate-pure')
const PRICE: LoomPriceRow = { provider: 'p', model: 'm', inputMissPerMTok: 2, inputHitPerMTok: 0.5, outputPerMTok: 4 }
const META = { id: ID } as SessionHeader
function log(...events: readonly Pick<SessionEvent, 'type' | 'data'>[]): SessionEvent[] {
  return events.map((event, seq) => ({ ...event, seq: SessionSeq(seq), time: seq }) as SessionEvent)
}
function header(model = 'm', reasoningEffort?: string, adapterDefault = false): EpochHeader {
  return { config: { provider: 'p', model, ...reasoningEffort === undefined ? {} : { reasoningEffort } }, ...adapterDefault ? { adapterDefaults: { reasoningEffort: true } } : {} } as EpochHeader
}
function requestHeader(model = 'm'): Pick<SessionEvent, 'type' | 'data'> {
  return { type: 'request/header', data: { reason: 'initial', header: header(model) } }
}
const prompt = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
function turn(number: number): Pick<SessionEvent, 'type' | 'data'>[] {
  return [
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [prompt] } },
    { type: 'turn/start', data: { turn: number } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [], removedCount: 1 } },
    { type: 'user/message', data: prompt },
    requestHeader(),
    { type: 'turn/end', data: { turn: number, reason: { kind: 'completed' } } },
  ]
}

describe('preview arithmetic', () => {
  it('uses all usage settlements of the repeated turn and ignores missing or zero usage', () => {
    const events = log(
      requestHeader(),
      { type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 2, outputTokens: 3 } } }] } },
      { type: 'assistant/attempt', data: { turn: 1, step: 2, stream: [] } },
      { type: 'assistant/attempt', data: { turn: 1, step: 3, stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } } }] } },
    )
    expect(turnBasis(events, 1)).toEqual({ miss: 13, hit: 5, output: 5 })
    expect(turnBasis(events, 2)).toBeUndefined()
    expect(turnBasis(log({ type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } } }] } }), 1)).toBeUndefined()
    expect(familyBasis([])).toBeUndefined()
    expect(familyBasis([
      { usage: { uncachedInputTokens: 20, cacheWriteTokens: 4, cacheReadTokens: 10, outputTokens: 6 }, turns: 2 },
      { usage: { uncachedInputTokens: 99, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, turns: 0 },
    ])).toEqual({ miss: 12, hit: 5, output: 3 })
  })

  it('returns no ranges without evidence, token counts without a price, and warm/cold list-price bounds', () => {
    expect(estimateValue(undefined, 'family', 2, undefined)).toEqual({ priced: false, cacheShare: 0, basis: 'family' })
    expect(estimateValue(undefined, 'family', 2, PRICE)).toEqual({ priced: true, cacheShare: 0, basis: 'family' })
    expect(estimateValue({ miss: 20, hit: 80, output: 50 }, 'own-turn', 3, undefined)).toEqual({ priced: false, cacheShare: 0.8, basis: 'own-turn', perBranch: { low: 150, high: 150 }, total: { low: 450, high: 450 } })
    expect(estimateValue({ miss: 20, hit: 80, output: 50 }, 'own-turn', 2, PRICE)).toEqual({ priced: true, cacheShare: 0.8, basis: 'own-turn', perBranch: { low: 0.00025, high: 0.0004 }, total: { low: 0.0005, high: 0.0008 } })
    expect(estimateValue({ miss: 0, hit: 0, output: 2 }, 'family', 1, PRICE).cacheShare).toBe(0)
    expect(estimateValue({ miss: 20, hit: 80, output: 50 }, 'own-turn', 1, { ...PRICE, inputMissPerMTok: 0, inputHitPerMTok: 2 }).perBranch).toEqual({ low: 0.0002, high: 0.0004 })
  })
})

describe('routes at a fork cut', () => {
  it('keeps caller reasoning efforts and omits adapter defaults, and gives later selections priority', () => {
    expect(routeOfHeader(header('m', 'high'))).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
    expect(routeOfHeader(header('m', 'high', true))).toEqual({ provider: 'p', model: 'm' })
    expect(sameRoute({ provider: 'p', model: 'm' }, { provider: 'q', model: 'm' })).toBe(false)
    expect(sameRoute({ provider: 'p', model: 'm' }, { provider: 'p', model: 'other' })).toBe(false)
    expect(sameRoute({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm', reasoningEffort: 'high' })).toBe(false)
    expect(nextRouteAt([], 0)).toBeUndefined()
    const events = log(requestHeader(), { type: 'model/selection', data: { provider: 'p', model: 'next' } })
    expect(headerRouteAt(events, 0)).toEqual({ provider: 'p', model: 'm' })
    expect(headerRouteAt(events, -1)).toBeUndefined()
    expect(nextRouteAt(events, 0)).toEqual({ provider: 'p', model: 'm' })
    expect(nextRouteAt(events, 1)).toEqual({ provider: 'p', model: 'next' })
  })

  it('reports a common own route only when every own request has that route', () => {
    const settlement = { type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [] } } satisfies Pick<SessionEvent, 'type' | 'data'>
    expect(ownRoute(log(requestHeader(), settlement, settlement), 1)).toEqual({ provider: 'p', model: 'm' })
    expect(ownRoute(log(requestHeader(), settlement, requestHeader('other'), settlement), 1)).toBeUndefined()
    expect(ownRoute(log(settlement), 0)).toBeUndefined()
    expect(ownRoute([], 0)).toBeUndefined()
  })

  it('uses the actual route of a fork first own turn for regenerate/edit, ahead of a stale selection', () => {
    const inherited = log(requestHeader('parent'), ...turn(1))
    const own = turn(2)
    own[4] = requestHeader('fork-route')
    const events = log(...inherited, { type: 'model/selection', data: { provider: 'p', model: 'stale-pick' } }, ...own)
    const source = { meta: { ...META, parentSession: SessionId('parent') }, inheritedEventCount: inherited.length, events }
    const request: LoomEstimateRequest = { sessionId: ID, kind: 'regenerate', turn: 2, count: 1 }
    expect(resolveEstimate(request, source, 8).selection).toEqual({ provider: 'p', model: 'fork-route' })
    expect(resolveEstimate({ ...request, kind: 'edit', selection: { provider: 'p', model: 'override' } }, source, 8).selection?.model).toBe('override')
    const same = log(...inherited, ...turn(2))
    expect(resolveEstimate(request, { ...source, events: same }, 8).selection?.model).toBe('m')
  })

  it('finds the first logged route before a root first request and refuses a repeated turn with no valid cut', () => {
    const request: LoomEstimateRequest = { sessionId: ID, kind: 'regenerate', turn: 1, count: 1 }
    const events = log({ type: 'sandbox/mode', data: { mode: 'read-only' } }, ...turn(1))
    expect(resolveEstimate(request, { meta: META, inheritedEventCount: 0, events }, 8).selection?.model).toBe('m')
    expect(resolveEstimate(request, { meta: META, inheritedEventCount: 0, events: events.filter(event => event.type !== 'request/header') }, 8)).not.toHaveProperty('selection')
    expect(() => resolveEstimate(request, { meta: META, inheritedEventCount: 0, events: log(...turn(1)) }, 8)).toThrow(expect.objectContaining({ code: 'loom/turn-unavailable' }))
  })
})
