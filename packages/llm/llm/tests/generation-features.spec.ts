/** Generation-time probability controls and auxiliary prefix admission use the captured exact-model capability. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import LlmRuntime, { createUserMessage, LlmAdapter, markAgentLoopRequest, ReasoningEffortId, ToolCallId } from '../src/index.ts'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '../src/types.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })
const ROUTE = { provider: 'features', model: 'mock' }
const MESSAGES = [createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } })]
class Adapter extends LlmAdapter {
  calls = 0
  constructor(readonly extra: Partial<LlmResolvedModelInfo>) { super() }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, ...this.extra }
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function setup(extra: Partial<LlmResolvedModelInfo> = {}) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(LlmRuntime)
  const adapter = new Adapter(extra)
  ctx.llm.registerAdapter(['features'], adapter)
  return { ctx, adapter }
}
async function chunks(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const result: StreamChunk[] = []
  for await (const chunk of stream) result.push(chunk)
  return result
}

describe('token probability requests', () => {
  it('captures detached capabilities and treats a probability control change as a prepared config mismatch', async () => {
    const { ctx, adapter } = await setup({ tokenLogprobs: { maxTopLogprobs: 5 }, assistantPrefill: 'tool-free' })
    const call = await ctx.llm.prepareCall({ ...ROUTE, topLogprobs: 0 })
    expect(call.tokenLogprobs).toEqual({ maxTopLogprobs: 5 })
    expect(call.assistantPrefill).toBe('tool-free')
    expect(Object.isFrozen(call.tokenLogprobs)).toBe(true)
    expect(() => call.stream({ ...call.config, messages: MESSAGES, topLogprobs: 1 })).toThrow(expect.objectContaining({ code: 'INVALID_PREPARED_CALL' }))
    await chunks(call.stream({ ...call.config, messages: MESSAGES }))
    expect(adapter.calls).toBe(1)
  })

  it('refuses unsupported and invalid counts at preparation and unprepared dispatch', async () => {
    const unsupported = await setup()
    await expect(unsupported.ctx.llm.prepareCall({ ...ROUTE, topLogprobs: 0 })).rejects.toMatchObject({ code: 'UNSUPPORTED_TOKEN_LOGPROBS' })
    const { ctx, adapter } = await setup({ tokenLogprobs: { maxTopLogprobs: 5 } })
    for (const topLogprobs of [-1, 1.5, 6]) {
      await expect(ctx.llm.prepareCall({ ...ROUTE, topLogprobs })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(await chunks(ctx.llm.stream({ ...ROUTE, messages: MESSAGES, topLogprobs }))).toMatchObject([
        { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST' } } },
      ])
    }
    expect(adapter.calls).toBe(0)
  })

  it('refuses malformed adapter capability metadata', async () => {
    for (const maxTopLogprobs of [-1, 1.5, 21]) {
      const { ctx } = await setup({ tokenLogprobs: { maxTopLogprobs } })
      await expect(ctx.llm.prepareCall(ROUTE)).rejects.toMatchObject({ code: 'INVALID_MODEL_INFO' })
    }
    const { ctx } = await setup({ assistantPrefill: 'arbitrary' as never })
    await expect(ctx.llm.prepareCall(ROUTE)).rejects.toMatchObject({ code: 'INVALID_MODEL_INFO' })
  })
})

describe('tool-free auxiliary prefixes', () => {
  it('refuses absent capability, empty text, loop requests, tools, tool history, and tool-call history before any dispatch', async () => {
    const unsupported = await setup()
    const absent = await unsupported.ctx.llm.prepareCall(ROUTE)
    expect(() => absent.stream({ ...ROUTE, messages: MESSAGES, assistantPrefix: 'Once' })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_ASSISTANT_PREFILL' }))
    const { ctx, adapter } = await setup({ assistantPrefill: 'tool-free' })
    const call = await ctx.llm.prepareCall(ROUTE)
    const base = { ...call.config, messages: MESSAGES, assistantPrefix: 'Once' }
    const invalid: GenerateOptions[] = [
      { ...base, assistantPrefix: '' },
      markAgentLoopRequest({ ...base }),
      { ...base, tools: [] },
      { ...base, toolHistory: { tools: [], updates: [] } },
      { ...base, messages: [{ role: 'tool', toolCallId: ToolCallId('call'), content: [] } as never] },
      { ...base, messages: [{ role: 'assistant', content: [{ type: 'tool-call', id: ToolCallId('call'), name: 'bash', arguments: '{}' }] } as never] },
    ]
    for (const request of invalid) expect(() => call.stream(request)).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    expect(await chunks(ctx.llm.stream({ ...base, tools: [] }))).toMatchObject([
      { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST' } } },
    ])
    expect(adapter.calls).toBe(0)
    await chunks(call.stream(base))
    expect(adapter.calls).toBe(1)
  })

  it('requires an explicit off effort for a reasoning route and admits its tool-free prefix when off is resolved', async () => {
    const { ctx } = await setup({
      assistantPrefill: 'tool-free',
      reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('high') },
    })
    const thinking = await ctx.llm.prepareCall(ROUTE)
    expect(() => thinking.stream({ ...thinking.config, messages: MESSAGES, assistantPrefix: 'Once' })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    const off = await ctx.llm.prepareCall({ ...ROUTE, reasoningEffort: ReasoningEffortId('off') })
    expect(await chunks(off.stream({ ...off.config, messages: MESSAGES, assistantPrefix: 'Once' }))).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  })
})
