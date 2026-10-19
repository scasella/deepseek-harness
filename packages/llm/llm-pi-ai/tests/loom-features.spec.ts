/** The actual pi-ai SDK preserves probability hooks and tool-free prefix payloads on local provider stand-ins. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as PiAi from '../src/index.ts'
import { resolveProfiles, Config } from '../src/config.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const roots: Context[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  await closeMockServers()
  vi.unstubAllEnvs()
})
const MESSAGES = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Continue' }] }]
async function setup(baseURL: string, mode: 'trailing-message' | 'deepseek-prefix' = 'trailing-message') {
  vi.stubEnv('PI_LOOM_KEY', 'test-key')
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(PiAi, { providers: { gateway: {
    apiKeyEnv: 'PI_LOOM_KEY', api: 'openai-completions', baseURL,
    compat: { supportsDeveloperRole: false, requiresReasoningContentOnAssistantMessages: true },
    models: [{ id: 'm', tokenLogprobs: { maxTopLogprobs: 5 }, assistantPrefill: mode, reasoningEfforts: { off: 'none', high: 'high' } }],
  } } })
  return ctx
}
async function stream(ctx: Context, extra: { topLogprobs?: number; assistantPrefix?: string } = {}): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream({ provider: 'gateway', model: 'm', messages: MESSAGES, reasoningEffort: ReasoningEffortId('off'), ...extra })) chunks.push(chunk)
  return chunks
}
const probabilities = [
  JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' }, index: 0, finish_reason: null }] }),
  JSON.stringify({ choices: [{ delta: { reasoning: 'thought' }, index: 0, finish_reason: null }] }),
  JSON.stringify({ choices: [{ delta: { content: 'hel' }, index: 0, finish_reason: null, logprobs: { content: [{ token: 'hel', logprob: -0.1, top_logprobs: [{ token: 'hel', logprob: -0.1 }] }] } }] }),
  JSON.stringify({ choices: [{ delta: { content: 'lo' }, index: 0, finish_reason: null, logprobs: { content: [{ token: 'lo', logprob: -9999, top_logprobs: [] }] } }] }),
  JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
  '[DONE]',
]

describe('pi-ai Loom generation features', () => {
  it('requests probabilities through samplingParams and captures them only on the answer text', async () => {
    const server = await mockServer([{ events: probabilities }])
    const ctx = await setup(server.url)
    const call = await ctx.llm.prepareCall({ provider: 'gateway', model: 'm', topLogprobs: 5, reasoningEffort: ReasoningEffortId('off') })
    expect(call.tokenLogprobs).toEqual({ maxTopLogprobs: 5 })
    expect(call.assistantPrefill).toBe('tool-free')
    const chunks = await stream(ctx, { topLogprobs: 5 })
    expect(server.requests[0]).toMatchObject({ logprobs: true, top_logprobs: 5 })
    const ends = chunks.filter(chunk => chunk.type === 'block-end')
    expect(ends.find(chunk => chunk.block.type === 'reasoning')).not.toHaveProperty('logprobs')
    expect(ends.find(chunk => chunk.block.type === 'text')?.logprobs).toEqual({ tokens: ['hel', 'lo'], logprobs: [-0.1, null], top: [[{ token: 'hel', logprob: -0.1 }], []] })
  })

  it.each(['trailing-message', 'deepseek-prefix'] as const)('sends the exact assistant prefix through %s', async (mode) => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await setup(server.url, mode)
    expect((await stream(ctx, { assistantPrefix: 'Once upon' })).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const body = server.requests[0] as { messages: Record<string, unknown>[] }
    expect(body.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Once upon' })
    if (mode === 'deepseek-prefix') {
      expect(body.messages.at(-1)).toHaveProperty('prefix', true)
      expect(body.messages.at(-1)).not.toHaveProperty('reasoning_content')
    } else expect(body.messages.at(-1)).not.toHaveProperty('prefix')
  })

  it('validates profile opt-ins and refuses a protocol that cannot transmit them', () => {
    for (const maxTopLogprobs of [-1, 21, 0.5]) expect(() => Config({ providers: { p: { models: [{ id: 'm', tokenLogprobs: { maxTopLogprobs } }] } } })).toThrow()
    const base = { api: 'openai-completions', baseURL: 'https://example.invalid', models: [{ id: 'm', tokenLogprobs: { maxTopLogprobs: 21 } }] }
    expect(() => resolveProfiles({ p: base })).toThrow('maxTopLogprobs')
    expect(() => resolveProfiles({ p: { api: 'anthropic-messages', baseURL: 'https://example.invalid', models: [{ id: 'm', assistantPrefill: 'trailing-message' }] } })).toThrow('require openai-completions')
    const profiles = resolveProfiles({ p: { api: 'openai-completions', baseURL: 'https://example.invalid', models: [
      { id: 'tokens-only', tokenLogprobs: { maxTopLogprobs: 0 } },
      { id: 'prefix-only', assistantPrefill: 'trailing-message' },
    ] } })
    expect(profiles.get('p')?.generationFeatures.get('tokens-only')).toEqual({ tokenLogprobs: { maxTopLogprobs: 0 } })
    expect(profiles.get('p')?.generationFeatures.get('prefix-only')).toEqual({ assistantPrefill: 'trailing-message' })
  })

  it('reports provider omission and emits the complete text without invented probabilities', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await setup(server.url)
    const warning = vi.spyOn(ctx.logger, 'warn')
    const chunks = await stream(ctx, { topLogprobs: 0 })
    expect(chunks.find(chunk => chunk.type === 'block-end')).not.toHaveProperty('logprobs')
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('omitted unaligned token probabilities'))
  })
})
