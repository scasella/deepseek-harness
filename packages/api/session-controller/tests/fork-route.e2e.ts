/**
 * Real-API e2e for fork children cut before the parent's second turn on a
 * route that is not the default model. A child without a selection runs on
 * the parent's provider and model and reads the parent's cached prompt
 * prefix, because its requests share the fork-family cache key; a child with
 * a selection runs on a second route alias of the same model without saving
 * the default. Gated on `OPENROUTER_DEEPSEEK_API_KEY`; every request disables
 * thinking.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { completedPrefixBefore } from '../src/index.ts'
import type { SessionForkRequest } from '../src/types.ts'
import { createSessionTestRemote } from './test-remote.ts'

const PROVIDER = 'openrouter-deepseek'
const ALIAS = 'openrouter-deepseek-alias'
const MODEL = 'deepseek/deepseek-v4.1-flash-1017'
const UNROUTED = { provider: 'unrouted-default', model: 'unrouted-default' }
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/**
 * A first prompt that the later prompts of the parent and the children ask
 * about, long enough (about 1,800 tokens) for the provider to cache its prefix.
 */
const FIRST_PROMPT = [
  'Read the following numbered inventory of a fictional warehouse, then reply with only the word "noted".',
  ...Array.from({ length: 80 }, (_, index) => {
    const item = index + 1
    return `${String(item)}. Shelf ${String(item % 12)} holds ${String(item * 7 % 31 + 1)} crates of part P-${String(1000 + item * 13)}, last counted on day ${String(item * 3 % 28 + 1)}.`
  }),
].join('\n')

const PROFILE: PiAiProviderProfile = {
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
}

function prompt(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const agents = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(LlmPiAi, { providers: { [PROVIDER]: PROFILE, [ALIAS]: PROFILE } })
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  const saved = vi.fn()
  const remote = createSessionTestRemote(ctx, {
    // No adapter serves the default route, so a child request on it would fail.
    defaultModelSelection: () => UNROUTED,
    saveDefaultModelSelection: saved,
    cwd: '/tmp',
  })
  return { ctx, agents, remote, saved }
}

/** Assistant message events a Session wrote itself, after its inherited prefix. */
function ownReplies(agent: Agent) {
  return agent.session.snapshotEvents().flatMap((event: SessionEvent) =>
    event.type === 'assistant/message' && event.seq >= agent.session.inheritedEventCount ? [event.data] : [])
}

function routeOf(reply: ReturnType<typeof ownReplies>[number] | undefined) {
  return { provider: reply?.message.source.provider, model: reply?.message.source.model }
}

describe.skipIf(!process.env.OPENROUTER_DEEPSEEK_API_KEY)('session fork route and cache reuse (real API)', () => {
  it('continues a fork on the parent route from the cached prefix and routes a selection only in its child', async () => {
    const { ctx, agents, remote, saved } = await harness()
    const parent = await agents.create(SessionId('fork-route-parent'), {
      provider: PROVIDER, model: MODEL, reasoningEffort: ReasoningEffortId('off'), maxTokens: 32,
    })
    parent.followup(prompt(FIRST_PROMPT))
    await parent.whenIdle()
    parent.followup(prompt('How many numbered lines did the inventory have? Reply with the number only.'))
    await parent.whenIdle()
    const parentReplies = ownReplies(parent)

    const atSeq = completedPrefixBefore(parent.session.snapshotEvents(), 2)
    if (atSeq === undefined) throw new Error('the parent has no completed prefix before turn 2')
    const forkAndPrompt = async (request: SessionForkRequest, text: string) => {
      const response = await remote.fork(request)
      if (!response.ok) throw response.error
      const child = ctx.agents.get(response.value.sessionId)
      if (child === undefined) throw new Error('the fork did not publish its child Agent')
      child.followup(prompt(text))
      await child.whenIdle()
      return ownReplies(child)
    }
    const [inherited] = await forkAndPrompt(
      { sessionId: parent.id, atSeq },
      'Which shelf holds part P-1013? Reply with the shelf number only.',
    )
    const [selected] = await forkAndPrompt(
      { sessionId: parent.id, atSeq, selection: { provider: ALIAS, model: MODEL, reasoningEffort: 'off' } },
      'Which part does line 3 list? Reply with the part number only.',
    )

    expect(parentReplies).toHaveLength(2)
    expect(parentReplies[1]?.usage?.cacheReadTokens ?? 0).toBeGreaterThan(0)
    expect(routeOf(inherited)).toEqual({ provider: PROVIDER, model: MODEL })
    expect(inherited?.usage?.cacheReadTokens ?? 0).toBeGreaterThan(0)
    expect(routeOf(selected)).toEqual({ provider: ALIAS, model: MODEL })
    expect(saved).not.toHaveBeenCalled()
    expect(ctx.agentDefaultModel.currentSelection()).toEqual(UNROUTED)
  }, 180_000)
})
