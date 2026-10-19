/** Prose previews use recorded own input, the selected route, and explicit output caps without provider calls. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AssistantStreamAccumulator, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoomEstimator, weaveBasis } from '../src/estimate.ts'
import type { LoomNodeId, LoomWeaveRequestRecord } from '../src/types.ts'
import { mountBranchHost } from './branch-host.ts'

const ROUTE = { provider: 'mock', model: 'mock' }
const PRICE = { ...ROUTE, inputMissPerMTok: 2, inputHitPerMTok: 0.5, outputPerMTok: 4 }
const SIGNAL = new AbortController().signal
const roots: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

function history(
  session: Session,
  prefix: string,
  samples: readonly (TokenUsage | undefined)[],
  route = ROUTE,
  kind: LoomWeaveRequestRecord['kind'] = 'weave',
): SessionSeq {
  const requestSeq = appendPluginRecord(session, 'plugin:loom/weave-request', {
    version: 1, parentNode: null, n: samples.length, config: route, topLogprobs: 0,
    system: 'Prose', messages: [{ role: 'user', content: [{ type: 'text', text: 'Continue.' }] }],
    assistantPrefix: prefix, prefixSpans: [{ text: prefix, author: 'user' }], stop: [], schedule: 'burst', kind,
  })
  for (const [index, usage] of samples.entries()) {
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'A' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'A' } },
      ...usage === undefined ? [] : [{ type: 'usage' as const, usage }], { type: 'finish', reason: { kind: 'stop' } },
    ]
    const stream = new AssistantStreamAccumulator()
    for (const chunk of chunks) stream.push({ time: 0, chunk })
    appendPluginRecord(session, 'plugin:loom/weave-node', {
      version: 1, id: brandString<LoomNodeId>(`node:${String(requestSeq)}:${String(index)}`), requestSeq, index, kind,
      stream: stream.snapshot(),
    })
  }
  return requestSeq
}

async function host(pricing = [PRICE]) {
  const ctx = new Context()
  roots.push(ctx)
  const mounted = await mountBranchHost(ctx, ROUTE, { maxBranchesPerRequest: 1, pricing, weave: { maxSiblings: 2, maxTokens: 40 } })
  const agent = await mounted.agents.create(SessionId('weave-estimate'), ROUTE)
  return { ctx, agent }
}

describe('recorded Weave input basis', () => {
  it('prefers exact-prefix own usage on the selected route and averages only reported siblings', () => {
    const session = Session.create(SessionId('weave-basis'))
    history(session, 'Cursor', [{ inputTokens: 999, outputTokens: 1 }])
    const inherited = session.snapshotEvents().length
    history(session, 'Cursor', [{ inputTokens: 900, outputTokens: 1 }], ROUTE, 'probe')
    history(session, 'Cursor', [{ inputTokens: 800, outputTokens: 1 }], { ...ROUTE, provider: 'other' })
    history(session, 'Cursor', [{ inputTokens: 700, outputTokens: 1 }], { ...ROUTE, model: 'other' })
    const matching = history(session, 'Cursor', [
      { inputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 5, outputTokens: 3 },
      { inputTokens: 30, cacheReadTokens: 70, outputTokens: 6 }, undefined,
    ])
    const latest = history(session, 'Different prefix', [{ inputTokens: 2, outputTokens: 10 }])
    history(session, 'Cursor', [{ inputTokens: 0, outputTokens: 0 }])
    expect(weaveBasis(session.snapshotEvents(), inherited, ROUTE, [{ text: 'Cursor', author: 'user' }], 40)).toEqual({
      basis: { miss: 22.5, hit: 80, output: 40 },
      historicalInput: { requestSeq: matching, samples: 2, ...ROUTE, prefixMatches: true },
    })
    expect(weaveBasis(session.snapshotEvents(), inherited, ROUTE, undefined, 20)).toEqual({
      basis: { miss: 2, hit: 0, output: 20 }, historicalInput: { requestSeq: latest, samples: 1, ...ROUTE, prefixMatches: false },
    })
    expect(weaveBasis(session.snapshotEvents(), inherited, ROUTE, [{ text: 'Never recorded', author: 'user' }], 10)?.historicalInput)
      .toMatchObject({ requestSeq: latest, prefixMatches: false })
    expect(weaveBasis(session.snapshotEvents(), inherited, { ...ROUTE, model: 'absent' }, [], 20)).toBeUndefined()
  })

  it('uses the newest exact match and leaves absent, zero, or inherited-only evidence unavailable', () => {
    const session = Session.create(SessionId('weave-newest-basis'))
    expect(weaveBasis([], 0, ROUTE, [], 20)).toBeUndefined()
    history(session, '', [undefined, { inputTokens: 0, outputTokens: 0 }])
    expect(weaveBasis(session.snapshotEvents(), 0, ROUTE, [], 20)).toBeUndefined()
    history(session, '', [{ inputTokens: 5, outputTokens: 1 }])
    const latest = history(session, '', [{ inputTokens: 0, cacheReadTokens: 10, outputTokens: 1 }])
    expect(weaveBasis(session.snapshotEvents(), 0, ROUTE, [], 20)).toEqual({
      basis: { miss: 0, hit: 10, output: 20 }, historicalInput: { requestSeq: latest, samples: 1, ...ROUTE, prefixMatches: true },
    })
    expect(weaveBasis(session.snapshotEvents(), session.snapshotEvents().length, ROUTE, [], 20)).toBeUndefined()
  })
})

describe('loom.estimate Weave previews', () => {
  it('prices historical input at the requested output cap and reports its exact source', async () => {
    const { ctx, agent } = await host()
    const requestSeq = history(agent.session, 'Cursor', [{ inputTokens: 20, cacheReadTokens: 80, outputTokens: 5 }])
    const resume = vi.spyOn(ctx.sessionController, 'resolveAgent')
    const fork = vi.spyOn(ctx.sessionController, 'fork')
    expect(await ctx.loom.estimate({ sessionId: agent.id, kind: 'weave', count: 2, maxTokens: 20,
      prefix: [{ text: 'Cursor', author: 'user' }], selection: ROUTE }, SIGNAL)).toEqual({
      priced: true, basis: 'weave-history', cacheShare: 0.8, outputCap: 20,
      perBranch: { low: 0.00013, high: 0.00028 }, total: { low: 0.00026, high: 0.00056 },
      historicalInput: { requestSeq, samples: 1, ...ROUTE, prefixMatches: true },
    })
    expect(resume).not.toHaveBeenCalled()
    expect(fork).not.toHaveBeenCalled()
  })

  it('uses the latest logged route and configured output cap, returning tokens without a configured price', async () => {
    const { ctx, agent } = await host([])
    const requestSeq = history(agent.session, 'Past', [{ inputTokens: 20, outputTokens: 3 }])
    agent.session.append('model/selection', ROUTE)
    expect(await ctx.loom.estimate({ sessionId: agent.id, kind: 'weave', count: 1 }, SIGNAL)).toEqual({
      priced: false, basis: 'weave-history', cacheShare: 0, outputCap: 40,
      perBranch: { low: 60, high: 60 }, total: { low: 60, high: 60 },
      historicalInput: { requestSeq, samples: 1, ...ROUTE, prefixMatches: false },
    })
  })

  it('does not invent zero-dollar or token figures without own reported usage on the requested route', async () => {
    const { ctx, agent } = await host()
    const request = { sessionId: agent.id, kind: 'weave' as const, count: 1 }
    expect(await ctx.loom.estimate(request, SIGNAL)).toEqual({ priced: false, basis: 'weave-history', cacheShare: 0, outputCap: 40 })
    expect(await ctx.loom.estimate({ ...request, selection: ROUTE }, SIGNAL)).toEqual({ priced: true, basis: 'weave-history', cacheShare: 0, outputCap: 40 })
    history(agent.session, 'Past', [{ inputTokens: 10, outputTokens: 2 }])
    expect(await ctx.loom.estimate({ ...request, selection: { ...ROUTE, model: 'unrecorded' } }, SIGNAL)).toEqual({
      priced: false, basis: 'weave-history', cacheShare: 0, outputCap: 40,
    })
  })

  it('enforces configured prose sibling and output limits independently of branch limits', async () => {
    const { ctx, agent } = await host()
    const request = { sessionId: agent.id, kind: 'weave' as const, count: 1, selection: ROUTE }
    for (const count of [0, 1.5, 3]) await expect(ctx.loom.estimate({ ...request, count }, SIGNAL))
      .rejects.toMatchObject({ code: 'loom/prose-unavailable', details: { reasonCode: 'limits' } })
    for (const maxTokens of [0, 1.5, 41]) await expect(ctx.loom.estimate({ ...request, maxTokens }, SIGNAL))
      .rejects.toMatchObject({ code: 'loom/prose-unavailable', details: { reasonCode: 'limits' } })
    const withoutPolicy = new LoomEstimator(ctx, 8, new Map())
    await expect(withoutPolicy.estimate(request, () => true, SIGNAL)).rejects.toMatchObject({ code: 'loom/prose-unavailable' })
  })

  it('honors cancellation without dispatching a provider call or writing a record', async () => {
    const { ctx, agent } = await host()
    const abort = new AbortController()
    const reason = new Error('closed preview')
    abort.abort(reason)
    await expect(ctx.loom.estimate({ sessionId: agent.id, kind: 'weave', count: 1, selection: ROUTE }, abort.signal)).rejects.toBe(reason)
    expect(agent.session.seq).toBe(0)
  })
})
