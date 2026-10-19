import { Context } from '@deepseek-ai/cordis'
import { AgentContinuationError, foldConsumedWork, installModelSelection, type Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(script: ConstructorParameters<typeof MockAdapter>[0] = [textResponse('continued')]) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const agents = await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock', 'switched'], adapter)
  const agent = await agents.create(SessionId('continue-test'), { provider: 'mock', model: 'mock' })
  return { ctx, agent, adapter }
}

function prompt(text = 'Answer from the recorded history.') {
  return createUserMessage({ content: [{ type: 'text' as const, text }], source: { kind: 'user' } })
}

function seedUser(agent: Agent): void {
  agent.session.append('user/message', prompt(), { surfaceOp: 'append' })
}

function events(agent: Agent): readonly SessionEvent[] {
  return agent.session.snapshotEvents()
}

describe('continuation admission', () => {
  it('requests existing user history without a new inbox item or user message', async () => {
    const { agent, adapter } = await harness()
    seedUser(agent)
    const inherited = agent.session.deriveMessages()
    agent.continue()
    expect(agent.status).toBe('running')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.messages.filter(message => message.role !== 'system')).toEqual(inherited)
    expect(events(agent).filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(events(agent).some(event => event.type === 'agent/inbox/spliced')).toBe(false)
    expect(events(agent).find(event => event.type === 'turn/start')?.data)
      .toEqual({ turn: 1, continuation: { kind: 'user' } })
    expect(events(agent).at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
  })

  it('refuses an empty history without writing a turn', async () => {
    const { agent } = await harness()
    expect(() =>{  agent.continue() }).toThrow(new AgentContinuationError('empty-history'))
    expect(events(agent)).toEqual([])
  })

  it('refuses an assistant tail without writing another turn', async () => {
    const { agent } = await harness()
    agent.followup(prompt())
    await agent.whenIdle()
    const before = events(agent)
    expect(() =>{  agent.continue() }).toThrow(new AgentContinuationError('assistant-tail'))
    expect(events(agent)).toEqual(before)
  })

  it('refuses retained tool calls whose results are missing even with a later user message', async () => {
    const { agent } = await harness()
    agent.session.append('assistant/message', { turn: 1, step: 1,
      message: createAssistantMessage({ content: [{ type: 'tool-call', id: ToolCallId('unsettled'), name: 'lookup', arguments: '{}' }],
        source: { provider: 'mock', model: 'mock' } }),
      stream: [],
    }, { surfaceOp: 'append' })
    seedUser(agent)
    const before = events(agent)
    expect(() =>{  agent.continue() }).toThrow(new AgentContinuationError('pending-tools'))
    expect(events(agent)).toEqual(before)
  })

  it.each(['next-turn', 'next-step'] as const)('refuses pending %s input without consuming it', async (target) => {
    const { agent } = await harness()
    seedUser(agent)
    agent.inbox.append(target, prompt('pending'))
    const before = events(agent)
    expect(() =>{  agent.continue() }).toThrow(new AgentContinuationError('pending-input'))
    expect(events(agent)).toEqual(before)
    expect(agent.inbox.nextTurn.length + agent.inbox.nextStep.length).toBe(1)
  })

  it('refuses a running driver and contains cancellation before its first step', async () => {
    const { agent, adapter } = await harness()
    seedUser(agent)
    agent.continue()
    expect(() =>{  agent.continue() }).toThrow(new AgentContinuationError('busy'))
    agent.cancel({ kind: 'hook', reason: 'test cancellation' })
    await agent.whenIdle()
    expect(adapter.requests).toEqual([])
    expect(events(agent).at(-1)?.data).toEqual({
      turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'test cancellation' } },
    })
    expect(foldConsumedWork(events(agent)).end?.data.turn).toBe(1)
  })

  it('refuses maintenance and leaves its owner running', async () => {
    const { agent } = await harness()
    seedUser(agent)
    const barrier = Promise.withResolvers<undefined>()
    const maintenance = agent.runMaintenance(() => barrier.promise)
    expect(() =>{  agent.continue() }).toThrow(new AgentContinuationError('busy'))
    barrier.resolve(undefined)
    await maintenance
    expect(events(agent).some(event => event.type === 'turn/start')).toBe(false)
  })

  it('retains accepted intent when a running-status observer cancels synchronously', async () => {
    const { agent, adapter } = await harness()
    seedUser(agent)
    agent.ctx.on('agent/status', ({ status }) => {
      if (status === 'running') agent.cancel({ kind: 'user' })
    })
    agent.continue()
    await agent.whenIdle()
    expect(adapter.requests).toEqual([])
    expect(events(agent).find(event => event.type === 'turn/start')?.data.continuation).toEqual({ kind: 'user' })
    expect(events(agent).at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  })

  it('honors a pre-step rejection and accounts for the refused continuation', async () => {
    const { agent, adapter } = await harness()
    seedUser(agent)
    agent.ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
    agent.continue()
    await agent.whenIdle()
    expect(adapter.requests).toEqual([])
    expect(events(agent).at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'blocked' } })
    expect(foldConsumedWork(events(agent)).end?.data.reason).toEqual({ kind: 'blocked' })
  })

  it('logs a model switch notice on an empty continuation step', async () => {
    const { agent, adapter } = await harness()
    seedUser(agent)
    agent.session.append('request/header', { reason: 'initial', header: { config: { provider: 'mock', model: 'mock' } } })
    agent.ctx.effect(() => installModelSelection(agent.ctx, {
      current: { provider: 'switched', model: 'alternate' }, assembled: undefined,
    }))
    agent.continue()
    await agent.whenIdle()
    expect(adapter.requests[0]?.provider).toBe('switched')
    const notice = events(agent).find(event => event.type === 'user/message' && event.data.source.kind === 'model-selection')
    expect(notice?.type === 'user/message' && notice.data.content).toEqual([{
      type: 'text',
      text: '[model changed: assistant turns above this point were generated by mock/mock; the session continues with switched/alternate]',
    }])
  })

  it('resumes after a recorded tool result and drains a later ordinary prompt separately', async () => {
    const { ctx, agent, adapter } = await harness([
      toolCallResponse('lookup-call', 'lookup', {}), textResponse('tool answer'), textResponse('follow-up answer'),
    ])
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({
      name: 'lookup', description: 'Return the stored value.', parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'counterfactual value' }]),
    })))
    const rejectSecondStep = agent.ctx.on('agent/pre-step', async ({ step }, next) => step === 2
      ? { kind: 'reject' } : next())
    agent.followup(prompt())
    await agent.whenIdle()
    rejectSecondStep()
    expect(agent.session.deriveMessages().at(-1)?.role).toBe('tool')
    agent.continue()
    agent.followup(prompt('ordinary follow-up'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests[1]?.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'counterfactual value' }])
    expect(events(agent).filter(event => event.type === 'turn/start').map(event => event.data))
      .toEqual([{ turn: 1 }, { turn: 2, continuation: { kind: 'user' } }, { turn: 3 }])
  })
})
