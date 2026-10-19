/** Non-owner continuation attribution and owner-only download refusal. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { PeerId, Principal, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountBranchHost } from './branch-host.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only caller whose continuation identity must survive persistence. */
    'loom-prose-guest': { readonly kind: 'loom-prose-guest' }
  }
}

const roots: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})
const GUEST: Principal = { kind: 'loom-prose-guest' }
const signal = (): AbortSignal => new AbortController().signal

function asGuest(ctx: Context, method: string): Context {
  const invocation: RemoteInvocation = {
    request: { namespace: 'loom', method, args: {} }, service: 'loom',
    peer: { id: brandString<PeerId>('loom-prose-peer'), ctx, principal: GUEST, interactions: 'answer', signal: signal(), dispose: async () => {} },
    signal: signal(),
    uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
  }
  return ctx.extend({ invocation })
}

async function harness() {
  const ctx = new Context()
  roots.push(ctx)
  const host = await mountBranchHost(ctx, { provider: 'mock', model: 'mock' })
  const adapter = new MockAdapter([
    toolCallResponse('lookup', 'lookup', {}), textResponse('original answer'), textResponse('continued answer'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: 'lookup', description: 'Read the recorded value.', parameters: {},
    execute: () => Promise.resolve([{ type: 'text', text: 'original result' }]),
  })))
  const agent = await host.agents.create(SessionId('principal-source'), { provider: 'mock', model: 'mock' })
  return { ctx, agent }
}

describe('Loom caller identity', () => {
  it('records the non-owner initiator in the counterfactual continuation turn', async () => {
    const { ctx, agent } = await harness()
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Look up a value.' }] }))
    await agent.whenIdle()
    const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    if (result?.type !== 'tool/result') throw new Error('Missing original tool result')
    const value = await asGuest(ctx, 'counterfactual').loom.counterfactual({
      sessionId: agent.id, resultSeq: result.seq, content: [{ type: 'text', text: 'guest result' }],
    }, signal())
    const child = ctx.agents.get(value.sessionId)
    if (child === undefined) throw new Error('Missing counterfactual child')
    await child.whenIdle()
    const turn = child.session.snapshotEvents().findLast(event => event.type === 'turn/start')
    expect(turn?.data).toMatchObject({ continuation: { kind: 'user', principal: GUEST } })
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/start')?.data).not.toHaveProperty('continuation')
  })

  it('refuses a non-owner download before inspecting Session contents or allocating a URL', async () => {
    const { ctx, agent } = await harness()
    const inspect = vi.spyOn(ctx.sessionController, 'inspect')
    expect(() => asGuest(ctx, 'export').loom.export({ sessionId: agent.id, mode: 'path' }, signal()))
      .toThrow(expect.objectContaining({ code: 'loom/export-unavailable', details: {
        sessionId: agent.id, reason: 'owner-connection-required',
      } }))
    expect(inspect).not.toHaveBeenCalled()
  })
})
