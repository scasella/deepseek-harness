import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { applySessionListMetadata } from '../src/list.ts'
import type { SessionRequestId } from '../src/types.ts'
import { createSessionTestRemote } from './test-remote.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(seed = true) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const agents = await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter([textResponse('continued')])
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }), cwd: '/tmp',
  })
  const agent = await agents.create(SessionId('continue-remote'), { provider: 'mock', model: 'mock' })
  if (seed) agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Existing prompt.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const request = { sessionId: agent.id, requestId: 'continue-rpc' as SessionRequestId }
  return { ctx, agent, adapter, remote, request }
}

describe('session.continue', () => {
  it('records its retry identity and publishes human activity once', async () => {
    const { ctx, agent, adapter, remote, request } = await harness()
    const activity = vi.fn()
    ctx.on('api-session/activity', activity)
    expect(await remote.continue(request)).toEqual({ ok: true, value: { accepted: true } })
    await agent.whenIdle()
    expect(await remote.continue(request)).toEqual({ ok: true, value: { accepted: true } })
    expect(adapter.requests).toHaveLength(1)
    expect(activity).toHaveBeenCalledOnce()
    const start = agent.session.snapshotEvents().find(event => event.type === 'turn/start')
    expect(start?.data).toEqual({ turn: 1, continuation: { kind: 'user', rpcId: request.requestId } })
    if (start === undefined) throw new Error('Missing continuation start')
    expect(applySessionListMetadata({ blank: false, lastPromptAt: null }, start))
      .toEqual({ blank: false, lastPromptAt: start.time })
  })

  it('returns a typed refusal without creating a turn', async () => {
    const { agent, remote, request } = await harness(false)
    expect(await remote.continue(request)).toMatchObject({
      ok: false, error: { code: 'session/continue-unavailable', details: { sessionId: agent.id, reason: 'empty-history' } },
    })
    expect(agent.session.snapshotEvents()).toEqual([])
  })

  it('does not admit an already canceled request', async () => {
    const { agent, remote, request } = await harness()
    const abort = new AbortController()
    abort.abort()
    expect(await remote.continue(request, abort.signal)).toMatchObject({ ok: false, error: { code: 'gateway/cancelled' } })
    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  })

  it('preserves unexpected driver failures as internal errors', async () => {
    const { agent, remote, request } = await harness()
    vi.spyOn(agent, 'continue').mockImplementationOnce(() => { throw new Error('driver unavailable') })
    expect(await remote.continue(request)).toMatchObject({
      ok: false, error: { code: 'gateway/internal', message: 'driver unavailable' },
    })
    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  })

  it('refuses admission when the required retry projection is unavailable', async () => {
    const { ctx, agent, remote, request } = await harness()
    vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValueOnce(undefined)
    expect(await remote.continue(request)).toMatchObject({
      ok: false, error: { code: 'gateway/internal', message: 'continuation retry state is unavailable' },
    })
    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
  })
})
