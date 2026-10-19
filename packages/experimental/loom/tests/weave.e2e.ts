/** Real OpenRouter prose siblings, captured probabilities, curation, and durable reload. */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { pluginRecordOf, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { mountBranchHost } from './branch-host.ts'

const PROVIDER = 'openrouter-loom'
const MODEL = 'deepseek/deepseek-v4.1-flash-1017'
const roots: Context[] = []
const stores: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(stores.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe.skipIf(!process.env.OPENROUTER_DEEPSEEK_API_KEY)('Loom prose (real API)', () => {
  it('retains four prose continuations and their token alternatives through a reload', async () => {
    const store = await mkdtemp(join(tmpdir(), 'dsh-loom-weave-e2e-'))
    stores.push(store)
    const ctx = new Context()
    roots.push(ctx)
    const selection = { provider: PROVIDER, model: MODEL, reasoningEffort: ReasoningEffortId('off') }
    const host = await mountBranchHost(ctx, selection, {
      weave: { maxSiblings: 4, maxTokens: 40, topLogprobs: 5, leadDelayMs: 100, temperature: 1.2 },
    }, store)
    await ctx.plugin(PiAi, { providers: { [PROVIDER]: {
      apiKeyEnv: 'OPENROUTER_DEEPSEEK_API_KEY', api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1',
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, supportsUsageInStreaming: true, maxTokensField: 'max_tokens', thinkingFormat: 'openrouter' },
      openRouterProvider: { order: ['deepseek'], allowFallbacks: false },
      models: [{ id: MODEL, contextWindow: 1_048_576, maxTokens: 393_216,
        reasoningEfforts: { off: null, low: 'low' }, tokenLogprobs: { maxTopLogprobs: 20 }, assistantPrefill: 'trailing-message',
      }],
    } } })
    const agent = await host.agents.create(SessionId('loom-weave-e2e'), selection, { cwd: store })
    const prefix = Array.from({ length: 48 }, (_, index) =>
      `At the station's ${String(index + 1)}th empty platform, Mara listened to rain tapping on the copper roof. Each departing train carried a sealed box whose label nobody could read. `,
    ).join('') + 'She finally opened the smallest box and found'
    let calls = 0
    ctx.on('llm/stream', (request, next) => {
      calls++
      expect(request.assistantPrefix).toBe(prefix)
      expect(request.tools).toBeUndefined()
      expect(agent.session.snapshotEvents().some(event => pluginRecordOf(event)?.type === 'plugin:loom/weave-request')).toBe(true)
      return next()
    })
    const signal = new AbortController().signal
    const value = await ctx.loom.weave({ sessionId: agent.id, parent: null, prefix: [{ text: prefix, author: 'user' }], n: 4 }, signal)
    expect(value.schedule).toBe('lead-then-burst')
    expect(calls).toBe(4)
    expect(value.nodes.map(node => ({ status: node.status, error: node.error })))
      .toEqual(Array.from({ length: 4 }, () => ({ status: 'completed', error: undefined })))
    for (const node of value.nodes) {
      expect(node.text.length).toBeGreaterThan(0)
      expect(node.logprobs?.tokens.join('')).toBe(node.text)
      expect(node.logprobs?.top.some(alternatives => alternatives.length > 1)).toBe(true)
    }
    expect(new Set(value.nodes.map(node => node.text)).size).toBeGreaterThan(1)
    expect(agent.session.deriveMessages()).toEqual([])
    expect(await ctx.loom.choose({ sessionId: agent.id, nodeId: value.nodes[0]!.id }, signal))
      .toMatchObject({ curationBits: 2 })
    const seq = agent.session.seq
    await ctx.loom.choose({ sessionId: agent.id, nodeId: value.nodes[0]!.id }, signal)
    expect(agent.session.seq).toBe(seq)
    const expected = await ctx.loom.weaveState({ sessionId: agent.id }, signal)
    await ctx.sessions.flush(agent.session)
    const handle = await ctx.sessionPersistence.open(agent.id, 'read')
    try {
      expect((await handle.read()).events).toEqual(agent.session.snapshotEvents())
    } finally {
      await handle.close()
    }
    console.info(`loom weave e2e: ${JSON.stringify({ siblings: value.nodes.length, distinct: new Set(value.nodes.map(node => node.text)).size,
      cacheReadTokens: value.nodes.map(node => node.usage?.cacheReadTokens ?? 0), curationBits: expected.curationBits })}`)
    await ctx.fiber.dispose()
    const reloaded = new Context()
    roots.push(reloaded)
    await mountBranchHost(reloaded, selection, {}, store)
    expect(await reloaded.loom.weaveState({ sessionId: agent.id }, signal)).toEqual(expected)
  }, 180_000)
})
