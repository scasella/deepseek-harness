/**
 * `Loom.branchFor`, the Host-only branch entry: each child's prompt carries
 * the caller's source, and the caller's preparation runs after the branch
 * record and before the prompt; a failed preparation fails that child.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { pluginRecordOf, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { LoomBranchRequestId, LoomSetId } from '../src/types.ts'
import { mountBranchHost } from './branch-host.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Test-only source of a Host caller's branch prompts. */
    'loom-test-host': { kind: 'loom-test-host'; readonly caller: string }
  }
}

const roots: Context[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
})

/** Answers every request at once. */
class EchoAdapter extends LlmAdapter {
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield * textResponse('reply')
  }
}

async function harness() {
  const ctx = new Context()
  roots.push(ctx)
  const host = await mountBranchHost(ctx, { provider: 'mock', model: 'mock' }, { concurrentWritableBranches: true })
  ctx.llm.registerAdapter(['mock'], new EchoAdapter())
  const source = await host.agents.create(SessionId('branch-for-source'), { provider: 'mock', model: 'mock' }, { cwd: '/tmp/branch-for' })
  source.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
  await source.whenIdle()
  return { ctx, source }
}

async function ownEvents(ctx: Context, sessionId: SessionId): Promise<readonly SessionEvent[]> {
  const inspection = await ctx.sessionController.inspect(sessionId)
  return inspection.events.slice(inspection.inheritedEventCount)
}

describe('Loom.branchFor', () => {
  it('prompts each child with the caller source after its record and the preparation', async () => {
    const { ctx, source } = await harness()
    const prepared: { agent: Agent; setId: LoomSetId; index: number }[] = []
    const value = await ctx.loom.branchFor(
      { kind: 'steer', sessionId: source.id, requestId: brandString<LoomBranchRequestId>('host-1'), afterTurn: 1, lines: ['a', 'b'] },
      {
        source: { kind: 'loom-test-host', caller: 'spec' },
        prepare: (agent, child) => {
          prepared.push({ agent, ...child })
          setSandboxMode(agent.session, 'read-only')
        },
      },
    )
    expect(prepared.map(({ setId, index }) => ({ setId, index })))
      .toEqual([{ setId: value.setId, index: 0 }, { setId: value.setId, index: 1 }])
    for (const [index, child] of value.children.entries()) {
      if (child.state !== 'started') throw new Error(`child ${String(index)} did not start`)
      expect(prepared[index]!.agent.session.id).toBe(child.sessionId)
      await prepared[index]!.agent.whenIdle()
      const own = await ownEvents(ctx, child.sessionId)
      const recordAt = own.findIndex(event => pluginRecordOf(event)?.type === 'plugin:loom/branch')
      const preparedAt = own.findIndex(event => event.type === 'sandbox/mode')
      const promptAt = own.findIndex(event => event.type === 'user/message')
      expect([recordAt < preparedAt, preparedAt < promptAt]).toEqual([true, true])
      expect((own[promptAt] as SessionEvent<'user/message'>).data.source).toEqual({ kind: 'loom-test-host', caller: 'spec' })
    }
  })

  it('branches beside a fork without asking the caller for access to the fork\'s parent', async () => {
    const { ctx, source } = await harness()
    const { sessionId: forkId } = await ctx.sessionController.fork({ sessionId: source.id })
    const fork = ctx.agents.get(forkId)!
    fork.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await fork.whenIdle()
    const value = await ctx.loom.branchFor(
      { kind: 'regenerate', sessionId: forkId, requestId: brandString<LoomBranchRequestId>('host-beside'), turn: 2, count: 1 },
      { source: { kind: 'loom-test-host', caller: 'beside' } },
    )
    const [child] = value.children
    if (child?.state !== 'started') throw new Error('the child did not start')
    expect(ctx.agents.get(child.sessionId)?.session.header.parentSession).toBe(source.id)
  })

  it('prompts without a preparation, and fails a child whose preparation throws without prompting it', async () => {
    const { ctx, source } = await harness()
    const plain = await ctx.loom.branchFor(
      { kind: 'steer', sessionId: source.id, requestId: brandString<LoomBranchRequestId>('host-2'), afterTurn: 1, lines: ['a'] },
      { source: { kind: 'loom-test-host', caller: 'plain' } },
    )
    expect(plain.children[0]).toMatchObject({ state: 'started' })
    const failed = await ctx.loom.branchFor(
      { kind: 'steer', sessionId: source.id, requestId: brandString<LoomBranchRequestId>('host-3'), afterTurn: 1, lines: ['a'] },
      { source: { kind: 'loom-test-host', caller: 'failing' }, prepare: () => { throw new Error('not ready') } },
    )
    const [child] = failed.children
    expect(child).toEqual({ index: 0, state: 'failed', code: 'gateway/internal', message: 'not ready', sessionId: expect.any(String) as string })
    if (child?.state !== 'failed' || child.sessionId === undefined) throw new Error('expected a failed child with a Session')
    expect((await ownEvents(ctx, child.sessionId)).filter(event => event.type === 'user/message')).toEqual([])
  })
})
