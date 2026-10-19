/** Cost previews over the real loop, route selections, and own/inherited usage projections. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as SessionStats from '@deepseek-ai/dsh-session-stats'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { Config } from '../src/index.ts'
import type { LoomBranchRequestId } from '../src/types.ts'
import { mountBranchHost } from './branch-host.ts'

const roots: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})
const SIGNAL = new AbortController().signal
const PRICING = [{ provider: 'mock', model: 'mock', inputMissPerMTok: 2, inputHitPerMTok: 0.5, outputPerMTok: 4 }]
let count = 0
async function setup(config: Config = {}, projections = true, reportUsage = true) {
  const ctx = new Context()
  roots.push(ctx)
  const host = await mountBranchHost(ctx, { provider: 'mock', model: 'mock' }, config)
  if (projections) {
    await ctx.plugin(SessionStats)
    await ctx.plugin(TokenMeter)
  }
  const adapter = new MockAdapter(Array.from({ length: 20 }, () => textResponse('reply').filter(chunk => reportUsage || chunk.type !== 'usage')))
  ctx.llm.registerAdapter(['mock'], adapter)
  count += 1
  const from = await host.agents.create(SessionId(`estimate-${String(count)}`), { provider: 'mock', model: 'mock' })
  setSandboxMode(from.session, 'read-only')
  from.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
  await from.whenIdle()
  return { ctx, host, from, adapter }
}

describe('loom.estimate', () => {
  it('prices repeated-turn ranges, prices overrides separately, and creates no branches or model calls', async () => {
    const { ctx, from, adapter } = await setup({ pricing: PRICING })
    const fork = vi.spyOn(ctx.sessionController, 'fork')
    const request = { sessionId: from.id, kind: 'regenerate' as const, turn: 1, count: 2 }
    expect(await ctx.loom.estimate(request, SIGNAL)).toEqual({
      priced: true, perBranch: { low: 0.000025, high: 0.00004 }, total: { low: 0.00005, high: 0.00008 }, cacheShare: 0, basis: 'own-turn',
    })
    expect(await ctx.loom.estimate({ ...request, selection: { provider: 'other', model: 'unpriced' } }, SIGNAL)).toEqual({
      priced: false, perBranch: { low: 15, high: 15 }, total: { low: 30, high: 30 }, cacheShare: 0, basis: 'own-turn',
    })
    expect(adapter.requests).toHaveLength(1)
    expect(fork).not.toHaveBeenCalled()
    expect(ctx.loom.ownUsd(from.session)).toBeCloseTo(0.00004)
  })

  it('uses each visible family member own usage once, with whole-log usage only for the root', async () => {
    const { ctx, from } = await setup({ pricing: PRICING })
    const value = await ctx.loom.branch({ sessionId: from.id, kind: 'steer', afterTurn: 1, lines: ['child'], requestId: brandString<LoomBranchRequestId>('estimate-child') })
    const child = value.children[0]!
    if (child.state !== 'started') throw new Error('child did not start')
    await ctx.agents.get(child.sessionId)!.whenIdle()
    expect(ctx.loom.ownUsd(ctx.agents.get(child.sessionId)!.session)).toBeCloseTo(0.00004)
    expect((await ctx.loom.compare({ sessionId: child.sessionId }, SIGNAL)).rows[0]?.own.usd).toEqual({ amount: 0.00004, label: 'list price' })
    const estimate = await ctx.loom.estimate({ sessionId: child.sessionId, kind: 'steer', afterTurn: 2, count: 1 }, SIGNAL)
    expect(estimate).toMatchObject({ priced: true, basis: 'family', perBranch: { low: 0.000025, high: 0.00004 } })
    const read = vi.spyOn(ctx.sessionController, 'projections')
    const allows = vi.spyOn(ctx.remoteAccess, 'allows').mockImplementation(resource => 'id' in resource && resource.id === child.sessionId)
    expect(await ctx.loom.estimate({ sessionId: child.sessionId, kind: 'variants', afterTurn: 2, count: 1 }, SIGNAL)).toMatchObject({ basis: 'family', priced: true })
    expect(read.mock.calls.map(([request]) => request.sessionId)).toEqual([child.sessionId])
    allows.mockRestore()
  })

  it('returns token figures without configured prices and refuses unavailable turns and invalid counts', async () => {
    const { ctx, from } = await setup()
    const request = { sessionId: from.id, kind: 'edit' as const, turn: 1, count: 1 }
    expect(await ctx.loom.estimate(request, SIGNAL)).toMatchObject({ priced: false, perBranch: { low: 15, high: 15 } })
    for (const count of [0, 1.5, 9]) await expect(ctx.loom.estimate({ ...request, count }, SIGNAL)).rejects.toMatchObject({ code: count === 9 ? 'loom/too-many-branches' : 'gateway/bad-request' })
    await expect(ctx.loom.estimate({ sessionId: from.id, kind: 'edit', count: 1 }, SIGNAL)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    for (const turn of [0, 1.5]) await expect(ctx.loom.estimate({ ...request, turn }, SIGNAL)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(ctx.loom.estimate({ ...request, turn: 9 }, SIGNAL)).rejects.toMatchObject({ code: 'loom/turn-unavailable' })
    await expect(ctx.loom.estimate({ ...request, sessionId: SessionId('missing') }, SIGNAL)).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('fails loudly when a family preview needs unmounted usage projections', async () => {
    const { ctx, from } = await setup({}, false)
    await expect(ctx.loom.estimate({ sessionId: from.id, kind: 'steer', afterTurn: 1, count: 1 }, SIGNAL)).rejects.toMatchObject({ code: 'gateway/internal' })
  })

  it('falls back to the family when a repeated turn has no reported usage, and leaves the ranges absent without evidence', async () => {
    const { ctx, from } = await setup({ pricing: PRICING }, true, false)
    expect(await ctx.loom.estimate({ sessionId: from.id, kind: 'regenerate', turn: 1, count: 1 }, SIGNAL)).toEqual({ priced: true, basis: 'family', cacheShare: 0 })
    expect(ctx.loom.ownUsd(from.session)).toBeUndefined()
    vi.spyOn(ctx.sessionController, 'list').mockResolvedValue({ items: [] })
    expect(await ctx.loom.estimate({ sessionId: from.id, kind: 'steer', afterTurn: 1, count: 1 }, SIGNAL)).toEqual({ priced: true, basis: 'family', cacheShare: 0 })
    const inspect = ctx.sessionController.inspect.bind(ctx.sessionController)
    vi.spyOn(ctx.sessionController, 'inspect').mockImplementation(async (id, signal) => {
      const value = await inspect(id, signal)
      return { ...value, events: value.events.filter(event => event.type !== 'request/header') }
    })
    expect(await ctx.loom.estimate({ sessionId: from.id, kind: 'steer', afterTurn: 1, count: 1 }, SIGNAL)).toEqual({
      priced: false, basis: 'family', cacheShare: 0,
    })
  })

  it('skips a family member deleted after listing and propagates every other read failure', async () => {
    const { ctx, from } = await setup()
    const request = { sessionId: from.id, kind: 'steer' as const, afterTurn: 1, count: 1 }
    const read = vi.spyOn(ctx.sessionController, 'projections').mockRejectedValueOnce(new RemoteError('session/not-found', 'removed', { sessionId: from.id }))
    expect(await ctx.loom.estimate(request, SIGNAL)).toEqual({ priced: false, basis: 'family', cacheShare: 0 })
    read.mockRejectedValueOnce(new Error('disk failure'))
    await expect(ctx.loom.estimate(request, SIGNAL)).rejects.toThrow('disk failure')
  })
})
