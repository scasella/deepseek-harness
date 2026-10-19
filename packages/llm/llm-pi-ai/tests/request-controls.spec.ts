/** Request controls pi-ai has no named option for, observed on the wire of a local provider stand-in. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { anthropicTextEvents, closeMockServers, mockServer, textEvents } from './mock-server.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await closeMockServers()
  vi.unstubAllEnvs()
})

/** A generation whose usage reports a reasoning breakdown, in the OpenRouter delta spelling. */
const reasoningEvents = [
  '{"choices":[{"delta":{"role":"assistant","reasoning":"thinking"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":6,"completion_tokens_details":{"reasoning_tokens":4}}}',
  '[DONE]',
]

/** Mount the adapter over the given routes, each reading its key from `PI_TEST_KEY`. */
async function mount(providers: Record<string, PiAiProviderProfile>): Promise<Context> {
  vi.stubEnv('PI_TEST_KEY', 'test-key')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers })
  return ctx
}

/** A hand-declared OpenRouter-style Chat Completions route on the stand-in. */
function openRouterRoute(baseURL: string, extra: Partial<PiAiProviderProfile> = {}): PiAiProviderProfile {
  return {
    apiKeyEnv: 'PI_TEST_KEY',
    api: 'openai-completions',
    baseURL,
    compat: { thinkingFormat: 'openrouter', supportsDeveloperRole: false },
    models: [
      { id: 'vendor/thinker', reasoningEfforts: { off: null, high: 'high' } },
      { id: 'vendor/spelled-off', reasoningEfforts: { off: 'none', high: 'high' } },
      { id: 'vendor/plain', reasoningEfforts: false },
    ],
    ...extra,
  }
}

describe('reasoning usage', () => {
  it('reports the provider reasoning breakdown as a subset of output', async () => {
    const server = await mockServer([{ events: reasoningEvents }, { events: textEvents }])
    const ctx = await mount({ gateway: openRouterRoute(server.url) })

    const thinking = await assemble(ctx, {
      provider: 'gateway',
      model: 'vendor/thinker',
      reasoningEffort: ReasoningEffortId('high'),
      messages: [],
    })
    expect(thinking.message.content).toEqual([{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'hello' }])
    expect(thinking.usage).toEqual({ inputTokens: 3, outputTokens: 6, totalTokens: 9, reasoningTokens: 4 })

    // pi-ai reports zero both when the provider sends no breakdown and when
    // nothing was spent on reasoning, so the count is left absent.
    const plain = await assemble(ctx, { provider: 'gateway', model: 'vendor/thinker', messages: [] })
    expect(plain.usage).toEqual({ inputTokens: 3, outputTokens: 1, totalTokens: 4 })
  })
})

describe('stop sequences', () => {
  it('sends them as the Chat Completions stop field', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await mount({ gateway: openRouterRoute(server.url) })

    const result = await assemble(ctx, { provider: 'gateway', model: 'vendor/plain', stop: ['END', '\n\n'], messages: [] })

    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.requests[0]).toMatchObject({ stop: ['END', '\n\n'] })
  })

  it('refuses them before network I/O on a protocol that would drop them', async () => {
    const server = await mockServer([])
    const ctx = await mount({
      messages: {
        apiKeyEnv: 'PI_TEST_KEY',
        api: 'anthropic-messages',
        baseURL: server.url,
        models: [{ id: 'm' }],
      },
    })

    const result = await assemble(ctx, { provider: 'messages', model: 'm', stop: ['END'], messages: [] })

    expect(result.finish).toMatchObject({
      kind: 'error',
      failure: {
        code: 'UNSUPPORTED_OPTION',
        message: 'llm-pi-ai sends stop sequences only to openai-completions models; model "m" speaks anthropic-messages',
      },
    })
    expect(server.requests).toEqual([])
  })
})

describe('OpenRouter provider routing', () => {
  it('sends the configured order and fallback policy as the provider field', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = await mount({
      pinned: openRouterRoute(server.url, { openRouterProvider: { order: ['deepseek'], allowFallbacks: false } }),
      ordered: openRouterRoute(server.url, { openRouterProvider: { order: ['deepseek', 'novita'] } }),
    })

    await assemble(ctx, { provider: 'pinned', model: 'vendor/plain', messages: [] })
    await assemble(ctx, { provider: 'ordered', model: 'vendor/plain', messages: [] })

    expect(server.requests[0]).toMatchObject({ provider: { order: ['deepseek'], allow_fallbacks: false } })
    expect(server.requests[1]).toHaveProperty('provider', { order: ['deepseek', 'novita'] })
  })

  it('leaves the provider field to Chat Completions models on a mixed-protocol route', async () => {
    const server = await mockServer([{ events: textEvents }, { events: anthropicTextEvents }])
    const ctx = await mount({
      openrouter: {
        apiKeyEnv: 'PI_TEST_KEY',
        baseURL: server.url,
        openRouterProvider: { order: ['deepseek'] },
      },
    })

    await assemble(ctx, { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', messages: [] })
    await assemble(ctx, { provider: 'openrouter', model: 'anthropic/claude-fable-5', messages: [] })

    expect(server.requests[0]).toMatchObject({ provider: { order: ['deepseek'] } })
    expect(server.requests[1]).not.toHaveProperty('provider')
  })

  it('sends no provider field from a route that configures none', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await mount({ gateway: openRouterRoute(server.url) })

    await assemble(ctx, { provider: 'gateway', model: 'vendor/plain', messages: [] })

    expect(server.requests[0]).not.toHaveProperty('provider')
  })
})

describe('OpenRouter thinking off', () => {
  it('disables reasoning explicitly when Off is declared without a wire spelling', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = await mount({ gateway: openRouterRoute(server.url) })

    await expect(ctx.llm.resolveModelInfo('gateway', 'vendor/thinker'))
      .resolves.toMatchObject({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } })
    await assemble(ctx, { provider: 'gateway', model: 'vendor/thinker', reasoningEffort: ReasoningEffortId('off'), messages: [] })
    await assemble(ctx, { provider: 'gateway', model: 'vendor/thinker', reasoningEffort: ReasoningEffortId('high'), messages: [] })

    expect(server.requests[0]).toHaveProperty('reasoning', { enabled: false })
    expect(server.requests[1]).toHaveProperty('reasoning', { effort: 'high' })
  })

  it('keeps a declared Off spelling and leaves non-reasoning models and other formats alone', async () => {
    const server = await mockServer([{ events: textEvents }, { events: textEvents }, { events: textEvents }])
    const ctx = await mount({
      gateway: openRouterRoute(server.url),
      // A non-reasoning model offers no effort to select, so Off reaches it only as the route default.
      quiet: openRouterRoute(server.url, { reasoning: 'off' }),
      native: openRouterRoute(server.url, { compat: { thinkingFormat: 'deepseek' } }),
    })
    const off = ReasoningEffortId('off')

    await assemble(ctx, { provider: 'gateway', model: 'vendor/spelled-off', reasoningEffort: off, messages: [] })
    await assemble(ctx, { provider: 'quiet', model: 'vendor/plain', messages: [] })
    await assemble(ctx, { provider: 'native', model: 'vendor/thinker', reasoningEffort: off, messages: [] })

    expect(server.requests[0]).toHaveProperty('reasoning', { effort: 'none' })
    expect(server.requests[1]).not.toHaveProperty('reasoning')
    expect(server.requests[2]).toMatchObject({ thinking: { type: 'disabled' } })
    expect(server.requests[2]).not.toHaveProperty('reasoning')
  })
})
