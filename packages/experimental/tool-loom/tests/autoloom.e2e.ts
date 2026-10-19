/**
 * Real-API e2e for autoloom on the OpenRouter DeepSeek route: a weaver
 * Session with a budget of three branches explores two continuations of a
 * one-line story through the loom tools, keeps the better one, and culls the
 * other. Every child must be a logged fork of the story whose first own prompt
 * carries the `loom` source and the child preset, the budgets must hold, and
 * the culled child must be archived. Gated on `OPENROUTER_DEEPSEEK_API_KEY`;
 * thinking is off for the story and the weaver, whose replies are capped. The
 * permission presets and the Workspace registry are the host harness
 * stand-ins; `loader-composition.spec.ts` covers the real services.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { pluginRecordOf, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { mountAutoloomHost } from './autoloom-host.ts'

const PROVIDER = 'openrouter-deepseek'
const MODEL = 'deepseek/deepseek-v4.1-flash-1017'
const key = process.env.OPENROUTER_DEEPSEEK_API_KEY
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const MAX_BRANCHES = 3
const MAX_OWN_TOKENS = 40_000

/** Tool calls of one Session, in log order. */
function toolCalls(events: readonly SessionEvent[]): { name: string; args: Record<string, unknown> }[] {
  return events.flatMap(event => event.type === 'assistant/message'
    ? event.data.message.content.flatMap(block => block.type === 'tool-call' ? [{ name: block.name, args: JSON.parse(block.arguments) as Record<string, unknown> }] : [])
    : [])
}

describe.skipIf(key === undefined || key === '')('autoloom (real API)', () => {
  it('explores two continuations of a story under its budget, keeps one, and archives the other', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-autoloom-e2e-'))
    cleanups.push(async () => { await rm(workspace, { recursive: true, force: true }) })
    const ctx = new Context()
    cleanups.push(async () => { await ctx.fiber.dispose() })
    const h = await mountAutoloomHost(ctx, {
      autoloom: { maxBranches: MAX_BRANCHES, maxDepth: 1, maxOwnTokens: MAX_OWN_TOKENS, childPermissionPreset: 'loom-child' },
      defaultWaitMs: 90_000,
    }, { concurrentWritableBranches: true, defaultIsolation: 'shared' })
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
    const route = { provider: PROVIDER, model: MODEL, reasoningEffort: ReasoningEffortId('off') }
    const prompt = async (agent: Agent, text: string): Promise<void> => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }

    const story = await h.agents.create(SessionId('autoloom-e2e-story'), { ...route, maxTokens: 60 }, { cwd: workspace })
    await prompt(story, 'Write the opening line of a very short story about a lighthouse keeper. Reply with that one line only.')
    const weaver = await h.agents.create(SessionId('autoloom-e2e-weaver'), { ...route, maxTokens: 800 }, { cwd: workspace })
    await prompt(weaver, [
      `Session ${story.id} holds the opening line of a story in its turn 1.`,
      'Use the loom tools to explore exactly two different continuations of it:',
      `1. Call loom_expand once with sessionId "${story.id}", afterTurn 1, and two lines, each asking for exactly one more sentence of the story in a different direction and nothing else.`,
      '2. Call loom_wait for the set it returns.',
      '3. Call loom_read for each child.',
      '4. Call loom_keep for the child whose sentence is better, and loom_cull for the other one.',
      'Then reply with the Session id you kept.',
    ].join('\n'))

    const weaverEvents = (await ctx.sessionController.inspect(weaver.id)).events
    const calls = toolCalls(weaverEvents)
    console.info(`autoloom e2e: weaver calls ${JSON.stringify(calls.map(call => call.name))}`)
    expect(calls.filter(call => call.name === 'loom_expand').length).toBeGreaterThanOrEqual(1)

    // Every Session forked from the story is a child the weaver started.
    const children = ctx.sessions.list().filter(session => session.header.parentSession === story.id)
    expect(children.length).toBeGreaterThanOrEqual(2)
    expect(children.length).toBeLessThanOrEqual(MAX_BRANCHES)
    let ownTokens = 0
    for (const child of children) {
      const inspection = await ctx.sessionController.inspect(child.id)
      const own = inspection.events.slice(inspection.inheritedEventCount)
      expect(own.some(event => pluginRecordOf(event)?.type === 'plugin:loom/branch')).toBe(true)
      expect(own.find(event => event.type === 'permission/preset')?.data).toEqual({ preset: 'loom-child' })
      const first = own.find((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
      expect(first?.data.source).toMatchObject({ kind: 'loom', weaver: weaver.id })
      const usage = ctx.sessionProjections.stateOf(child, 'tokenUsage')?.usage.fork?.own
      ownTokens += usage === undefined ? 0 : usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens
    }
    console.info(`autoloom e2e: ${String(children.length)} children, ${String(ownTokens)} own tokens`)
    expect(ownTokens).toBeLessThanOrEqual(MAX_OWN_TOKENS)

    const childIds = new Set<string>(children.map(child => child.id))
    expect(h.archived).toHaveLength(1)
    expect(childIds.has(h.archived[0]!)).toBe(true)
    const kept = children.filter(child => ctx.sessionProjections.stateOf(child, 'loomMark')?.mark?.mark === 'keep')
    expect(kept.length).toBeGreaterThanOrEqual(1)
    expect(kept.map(child => child.id)).not.toContain(h.archived[0])
  }, 240_000)
})
