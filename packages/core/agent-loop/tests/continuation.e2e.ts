/** OpenRouter-gated continuation over a recorded prompt, without adding input. */
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it } from 'vitest'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe.skipIf(!process.env.OPENROUTER_DEEPSEEK_API_KEY)('continuation entry (real API)', () => {
  it('answers an existing prompt and records only the continuation marker as new input attribution', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const agents = await mountAgentLoopTestHarness(ctx)
    const model = 'deepseek/deepseek-v4.1-flash-1017'
    await ctx.plugin(LlmPiAi, { providers: {
      'openrouter-deepseek': {
        apiKeyEnv: 'OPENROUTER_DEEPSEEK_API_KEY', api: 'openai-completions',
        baseURL: 'https://openrouter.ai/api/v1',
        compat: {
          supportsDeveloperRole: false, supportsReasoningEffort: true,
          supportsUsageInStreaming: true, maxTokensField: 'max_tokens', thinkingFormat: 'openrouter',
        },
        openRouterProvider: { order: ['deepseek'], allowFallbacks: false },
        models: [{ id: model, contextWindow: 1_048_576, maxTokens: 393_216, reasoningEfforts: { off: null, low: 'low' } }],
      },
    } })
    const agent = await agents.create(SessionId('continuation-e2e'), {
      provider: 'openrouter-deepseek', model, reasoningEffort: ReasoningEffortId('off'), maxTokens: 32,
    })
    const prompt = renderPrompt(await ctx.systemPrompt.assemble(assembleContextFor(agent)))
    agent.session.append('system/message', { turn: 1, step: 1, message: createSystemMessage(prompt) }, { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Reply with exactly CONTINUATION_OK.' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.continue()
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    expect(events.at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
    expect(events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(events.some(event => event.type === 'agent/inbox/spliced')).toBe(false)
    expect(events.find(event => event.type === 'turn/start')?.data.continuation).toEqual({ kind: 'user' })
    const answer = agent.session.deriveMessages().at(-1)?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(answer?.trim()).toBe('CONTINUATION_OK')
  })
})
