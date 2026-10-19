import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'

/**
 * Real-API e2e for an OpenRouter route serving DeepSeek V4.1 Flash under its
 * plain model id, pinned to the DeepSeek provider with fallbacks disabled:
 * streaming, the reasoning usage count, thinking off, and stop sequences.
 * Gated on `OPENROUTER_DEEPSEEK_API_KEY`; every request caps output at 64 tokens.
 */

const PROVIDER = 'openrouter-deepseek'
const MODEL = 'deepseek/deepseek-v4.1-flash-1017'
const MAX_TOKENS = 64
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: {
      [PROVIDER]: {
        apiKeyEnv: 'OPENROUTER_DEEPSEEK_API_KEY',
        api: 'openai-completions',
        baseURL: 'https://openrouter.ai/api/v1',
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          supportsUsageInStreaming: true,
          maxTokensField: 'max_tokens',
          thinkingFormat: 'openrouter',
        },
        openRouterProvider: { order: ['deepseek'], allowFallbacks: false },
        models: [{
          id: MODEL,
          contextWindow: 1_048_576,
          maxTokens: 393_216,
          reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
        }],
      },
    },
  })
  return ctx
}

interface Collected {
  chunks: StreamChunk[]
  message: Message
  usage?: TokenUsage
  finish: FinishReason
}

/** Stream one request, keeping the raw chunks beside the assembled message. */
async function collect(ctx: Context, options: Omit<GenerateOptions, 'provider' | 'model' | 'maxTokens'>): Promise<Collected> {
  const assembler = new BlockAssembler()
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream({ provider: PROVIDER, model: MODEL, maxTokens: MAX_TOKENS, ...options })) {
    chunks.push(chunk)
    assembler.push(chunk)
  }
  return {
    chunks,
    message: assembler.message({ provider: PROVIDER, model: MODEL }),
    ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    finish: assembler.finish,
  }
}

function ask(text: string): Message[] {
  return [createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: PROVIDER, model: MODEL },
  })]
}

function textOf(result: Collected): string {
  return result.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function hasReasoning(result: Collected): boolean {
  return result.message.content.some(block => block.type === 'reasoning')
}

describe.skipIf(!process.env.OPENROUTER_DEEPSEEK_API_KEY)('llm-pi-ai OpenRouter DeepSeek e2e (real API)', () => {
  it('streams text from the pinned provider under the plain model id', async () => {
    const result = await collect(await harness(), {
      reasoningEffort: ReasoningEffortId('off'),
      messages: ask('Reply with exactly the word: pong'),
    })

    expect(result.finish, JSON.stringify(result.finish)).toEqual({ kind: 'stop' })
    expect(result.chunks.filter(chunk => chunk.type === 'text-delta').length).toBeGreaterThan(0)
    expect(textOf(result).toLowerCase()).toContain('pong')
    expect(result.usage?.inputTokens).toBeGreaterThan(0)
    expect(result.usage?.outputTokens).toBeGreaterThan(0)
  })

  it('reports the reasoning token count when thinking is on', async () => {
    const result = await collect(await harness(), {
      reasoningEffort: ReasoningEffortId('low'),
      messages: ask('What is 2 + 2? Answer with one digit.'),
    })

    // A 64-token cap may end the turn inside its reasoning.
    expect(['stop', 'max-tokens'], JSON.stringify(result.finish)).toContain(result.finish.kind)
    expect(hasReasoning(result)).toBe(true)
    expect(result.usage?.reasoningTokens).toBeGreaterThan(0)
    expect(result.usage?.reasoningTokens).toBeLessThanOrEqual(result.usage?.outputTokens ?? 0)
  })

  it('returns no reasoning when thinking is off', async () => {
    const result = await collect(await harness(), {
      reasoningEffort: ReasoningEffortId('off'),
      messages: ask('What is 2 + 2? Answer with one digit.'),
    })

    expect(result.finish, JSON.stringify(result.finish)).toEqual({ kind: 'stop' })
    expect(hasReasoning(result)).toBe(false)
    expect(result.usage).not.toHaveProperty('reasoningTokens')
    expect(textOf(result)).toContain('4')
  })

  it('ends the reply at a stop sequence', async () => {
    const result = await collect(await harness(), {
      reasoningEffort: ReasoningEffortId('off'),
      messages: ask('Count from 1 to 10 as digits separated by single spaces. Output nothing else.'),
      stop: ['5'],
    })

    expect(result.finish, JSON.stringify(result.finish)).toEqual({ kind: 'stop' })
    const text = textOf(result)
    expect(text).toContain('4')
    expect(text).not.toMatch(/[5-9]/)
  })
})
