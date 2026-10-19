/** Local-only real-provider guard for generation-time probabilities and tool-free assistant prefixes. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, ReasoningEffortId, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import * as PiAi from '../src/index.ts'

const PROVIDER = 'openrouter-loom'
const MODEL = 'deepseek/deepseek-v4.1-flash-1017'
const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })
async function setup(): Promise<Context> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(PiAi, { providers: { [PROVIDER]: {
    apiKeyEnv: 'OPENROUTER_DEEPSEEK_API_KEY', api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1',
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, supportsUsageInStreaming: true, maxTokensField: 'max_tokens', thinkingFormat: 'openrouter' },
    openRouterProvider: { order: ['deepseek'], allowFallbacks: false },
    models: [{ id: MODEL, contextWindow: 1_048_576, maxTokens: 393_216, reasoningEfforts: { off: null, low: 'low' }, tokenLogprobs: { maxTopLogprobs: 20 }, assistantPrefill: 'trailing-message' }],
  } } })
  return ctx
}
const messages = (text: string) => [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })]
async function collect(ctx: Context, extra: Omit<GenerateOptions, 'provider' | 'model'>) {
  const assembler = new BlockAssembler()
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream({ provider: PROVIDER, model: MODEL, ...extra })) {
    chunks.push(chunk)
    assembler.push(chunk)
  }
  return { chunks, assembler }
}

describe.skipIf(!process.env.OPENROUTER_DEEPSEEK_API_KEY)('OpenRouter Loom generation features (real API)', () => {
  it('captures aligned sampled-token probabilities with reasoning off', async () => {
    const { chunks, assembler } = await collect(await setup(), { reasoningEffort: ReasoningEffortId('off'), maxTokens: 32, topLogprobs: 5, messages: messages('Reply with exactly the words: The moon is bright.') })
    expect(assembler.finish).toEqual({ kind: 'stop' })
    const text = chunks.filter((chunk): chunk is Extract<StreamChunk, { type: 'block-end' }> => chunk.type === 'block-end' && chunk.block.type === 'text')
    expect(text.length).toBeGreaterThan(0)
    for (const block of text) {
      expect(block.logprobs?.tokens.join('')).toBe(block.block.type === 'text' ? block.block.text : '')
      expect(block.logprobs?.logprobs.length).toBeGreaterThan(0)
      expect(block.logprobs?.top.every(alternatives => alternatives.length <= 5)).toBe(true)
    }
  })

  it('keeps thinking probabilities absent while capturing the final answer', async () => {
    const { chunks, assembler } = await collect(await setup(), { reasoningEffort: ReasoningEffortId('low'), maxTokens: 256, topLogprobs: 5, messages: messages('What is 2+2? Respond with one digit.') })
    expect(assembler.finish).toEqual({ kind: 'stop' })
    const ends = chunks.filter(chunk => chunk.type === 'block-end')
    expect(ends.some(chunk => chunk.block.type === 'reasoning')).toBe(true)
    for (const block of ends.filter(chunk => chunk.block.type === 'reasoning')) expect(block).not.toHaveProperty('logprobs')
    expect(ends.some(chunk => chunk.block.type === 'text' && chunk.logprobs !== undefined)).toBe(true)
  })

  it('continues a mid-sentence prefix and rejects tool history before provider dispatch', async () => {
    const ctx = await setup()
    const { chunks, assembler } = await collect(ctx, { reasoningEffort: ReasoningEffortId('off'), maxTokens: 32, assistantPrefix: 'The tiny robot opened the', messages: messages('Continue the supplied story sentence with a short ending.') })
    expect(assembler.finish).toEqual({ kind: 'stop' })
    expect(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text.length > 0)).toBe(true)
    const call = await ctx.llm.prepareCall({ provider: PROVIDER, model: MODEL, reasoningEffort: ReasoningEffortId('off') })
    expect(() => call.stream({ ...call.config, assistantPrefix: 'The', messages: [{ role: 'tool', toolCallId: ToolCallId('prior'), content: [] } as never] })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })
})
