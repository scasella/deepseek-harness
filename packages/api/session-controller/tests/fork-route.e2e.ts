/**
 * Real-API e2e for a fork cut before the parent's second turn on a route that
 * is not the default model: the child's first own request runs on the
 * parent's provider and model. Gated on `OPENROUTER_DEEPSEEK_API_KEY`; every
 * request disables thinking and caps output at 32 tokens.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ReasoningEffortId, type AssistantMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { completedPrefixBefore } from '../src/index.ts'
import { createSessionTestRemote } from './test-remote.ts'

const PROVIDER = 'openrouter-deepseek'
const MODEL = 'deepseek/deepseek-v4.1-flash-1017'
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** A first prompt that the later prompts of the parent and the child ask about. */
const FIRST_PROMPT = [
  'Read the following numbered inventory of a fictional warehouse, then reply with only the word "noted".',
  ...Array.from({ length: 12 }, (_, index) => {
    const item = index + 1
    return `${String(item)}. Shelf ${String(item % 12)} holds ${String(item * 7 % 31 + 1)} crates of part P-${String(1000 + item * 13)}, last counted on day ${String(item * 3 % 28 + 1)}.`
  }),
].join('\n')

function prompt(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const agents = await mountAgentLoopTestHarness(ctx)
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
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  return { ctx, agents }
}

/** Assistant messages a Session wrote itself, after its inherited prefix. */
function ownAssistantMessages(events: readonly SessionEvent[], inheritedEventCount: number) {
  return events.flatMap(event => event.type === 'assistant/message' && event.seq >= inheritedEventCount ? [event.data] : [])
}

describe.skipIf(!process.env.OPENROUTER_DEEPSEEK_API_KEY)('session fork route and cache reuse (real API)', () => {
  it('continues a fork on the parent route instead of the default model', async () => {
    const { ctx, agents } = await harness()
    const parent = await agents.create(SessionId('fork-route-parent'), {
      provider: PROVIDER, model: MODEL, reasoningEffort: ReasoningEffortId('off'), maxTokens: 32,
    })
    parent.followup(prompt(FIRST_PROMPT))
    await parent.whenIdle()
    parent.followup(prompt('How many numbered lines did the inventory have? Reply with the number only.'))
    await parent.whenIdle()
    const parentReplies = ownAssistantMessages(parent.session.snapshotEvents(), 0)
    expect(parentReplies).toHaveLength(2)

    const atSeq = completedPrefixBefore(parent.session.snapshotEvents(), 2)
    if (atSeq === undefined) throw new Error('the parent has no completed prefix before turn 2')
    const response = await createSessionTestRemote(ctx, {
      // No adapter serves the default route, so a child request on it would fail.
      defaultModelSelection: () => ({ provider: 'unrouted-default', model: 'unrouted-default' }),
      cwd: '/tmp',
    }).fork({ sessionId: parent.id, atSeq })
    if (!response.ok) throw response.error
    const child = ctx.agents.get(response.value.sessionId)
    if (child === undefined) throw new Error('the fork did not publish its child Agent')
    child.followup(prompt('Which shelf holds part P-1013? Reply with the shelf number only.'))
    await child.whenIdle()

    const route = (message: AssistantMessage | undefined) => ({ provider: message?.source.provider, model: message?.source.model })
    const [first] = ownAssistantMessages(child.session.snapshotEvents(), child.session.inheritedEventCount)
    expect(route(first?.message)).toEqual({ provider: PROVIDER, model: MODEL })
    expect(route(first?.message)).toEqual(route(parentReplies[0]?.message))
  }, 120_000)
})
