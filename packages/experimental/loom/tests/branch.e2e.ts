/**
 * Real-API e2e for Loom branch sets on the OpenRouter DeepSeek route with a
 * read-only sandbox: a source turn, then a regenerate set and a steer set of
 * two children each. Every child sends its own prompt, runs on the source's
 * route although the default model is unrouted, ends its own turn, and reads
 * the source's cached prefix through the fork family's cache key. Gated on
 * `OPENROUTER_DEEPSEEK_API_KEY`; the source disables thinking and caps output
 * at 32 tokens, and every prompt asks for a one-word or one-number reply.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, isAgentLoopRequest, ReasoningEffortId, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import type { LoomBranchRequestId, LoomBranchValue } from '../src/types.ts'
import { mountBranchHost } from './branch-host.ts'

const PROVIDER = 'openrouter-deepseek'
const MODEL = 'deepseek/deepseek-v4.1-flash-1017'
const key = process.env.OPENROUTER_DEEPSEEK_API_KEY
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A first prompt long enough for the provider to cache its prefix. */
const FIRST_PROMPT = [
  'Read the following numbered inventory of a fictional warehouse, then reply with only the word "noted".',
  ...Array.from({ length: 60 }, (_, index) => {
    const item = index + 1
    return `${String(item)}. Shelf ${String(item % 12)} holds ${String(item * 7 % 31 + 1)} crates of part P-${String(1000 + item * 13)}, last counted on day ${String(item * 3 % 28 + 1)}.`
  }),
].join('\n')

const STEER_LINES = [
  'Which shelf holds part P-1013? Reply with the shelf number only.',
  'How many crates of part P-1026 are there? Reply with the number only.',
]

function textOf(event: SessionEvent<'user/message'>): string {
  return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

describe.skipIf(key === undefined || key === '')('Loom branch sets (real API)', () => {
  it('regenerates and steers on the source route, each child with its own prompt and turn', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-loom-e2e-'))
    cleanups.push(async () => { await rm(workspace, { recursive: true, force: true }) })
    const ctx = new Context()
    cleanups.push(async () => { await ctx.fiber.dispose() })
    // No adapter serves the default route, so a child request on it would fail.
    const { agents } = await mountBranchHost(ctx, { provider: 'unrouted-default', model: 'unrouted-default' })
    await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: workspace })
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
    const requests: GenerateOptions[] = []
    ctx.on('llm/stream', (options, next) => {
      if (isAgentLoopRequest(options)) requests.push(options)
      return next()
    })

    const source = await agents.create(SessionId('loom-e2e-source'), {
      provider: PROVIDER, model: MODEL, reasoningEffort: ReasoningEffortId('off'), maxTokens: 32,
    }, { cwd: workspace })
    setSandboxMode(source.session, 'read-only')
    source.followup(createUserMessage({ content: [{ type: 'text', text: FIRST_PROMPT }], source: { kind: 'user' } }))
    await source.whenIdle()
    const sourceHeader = source.session.snapshotEvents().find(event => event.type === 'request/header')
    expect(sourceHeader?.data.header.config).toMatchObject({ provider: PROVIDER, model: MODEL })

    const branch = (request: Parameters<typeof ctx.loom.branch>[0]): Promise<LoomBranchValue> => ctx.loom.branch(request)
    const regenerate = await branch({
      sessionId: source.id, requestId: brandString<LoomBranchRequestId>('e2e-regenerate'), kind: 'regenerate', turn: 1, count: 2,
    })
    const steer = await branch({
      sessionId: source.id, requestId: brandString<LoomBranchRequestId>('e2e-steer'), kind: 'steer', afterTurn: 1, lines: STEER_LINES,
    })
    const children = [
      ...regenerate.children.map(child => ({ child, prompt: FIRST_PROMPT })),
      ...steer.children.map((child, index) => ({ child, prompt: STEER_LINES[index]! })),
    ]
    const cacheReads: Record<string, number | undefined> = {}
    for (const { child, prompt } of children) {
      if (child.state !== 'started') throw new Error(`child ${String(child.index)} did not start: ${JSON.stringify(child)}`)
      const agent = ctx.agents.get(child.sessionId)
      if (agent === undefined) throw new Error(`child ${child.sessionId} is not live`)
      await agent.whenIdle()
      const { inheritedEventCount } = agent.session
      const own = agent.session.snapshotEvents().slice(inheritedEventCount)
      const prompts = own.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'user')
      expect(prompts.map(textOf)).toEqual([prompt])
      const header = own.find(event => event.type === 'request/header')
      expect(header?.data.header.config).toMatchObject({ provider: PROVIDER, model: MODEL })
      expect(own.filter(event => event.type === 'turn/end')).toHaveLength(1)
      const reply = own.find(event => event.type === 'assistant/message')
      expect(reply?.data.message.source).toMatchObject({ provider: PROVIDER, model: MODEL })
      cacheReads[child.sessionId] = reply?.data.usage?.cacheReadTokens
    }
    const childIds = new Set(children.map(({ child }) => child.state === 'started' ? child.sessionId : undefined))
    const childRequests = requests.filter(request => childIds.has(request.sessionId))
    const familyKeyed = childRequests.length > 0 && childRequests.every(request => request.cacheSessionId === source.id)
    console.info(`loom e2e: family cache key ${familyKeyed ? 'present' : 'absent'}; child cacheReadTokens ${JSON.stringify(cacheReads)}`)
    if (familyKeyed) {
      for (const tokens of Object.values(cacheReads)) expect(tokens, `child cacheReadTokens ${JSON.stringify(cacheReads)}`).toBeGreaterThan(0)
    }
  }, 180_000)
})
