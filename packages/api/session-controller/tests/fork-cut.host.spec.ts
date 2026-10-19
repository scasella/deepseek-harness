/** Fork cuts before a turn's opening input, and the queued prompts such a cut carries into the child. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { completedPrefixBefore, inheritedNextTurnPrompts } from '../src/index.ts'
import { latestCompletedPrefixBoundary } from '../src/fork-cut.ts'
import { createSessionTestRemote } from './test-remote.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const prompt = (text: string): UserMessage => createUserMessage({
  content: [{ type: 'text', text }], source: { kind: 'user', rpcId: `rpc-${text}` },
})

interface Fixture {
  readonly ctx: Context
  readonly loop: AgentLoopTestHarness
  readonly source: Agent
}

async function fixture(): Promise<Fixture> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  const source = await loop.create(SessionId('fork-cut-source'), {}, { cwd: '/workspace' })
  return { ctx, loop, source }
}

/** Run one turn through the production Inbox: claim its queued prompt, admit it, and end the turn. */
function runTurn(fixture: Fixture, turn: number, during: () => void = () => {}): void {
  const { session } = fixture.source
  session.append('turn/start', { turn })
  const [claimed] = fixture.loop.claim(fixture.source, 'next-turn', turn)
  if (claimed === undefined) throw new Error(`turn ${String(turn)} has no queued prompt`)
  session.append('user/message', claimed, { surfaceOp: 'append' })
  during()
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function eventsOf(agent: Agent): readonly SessionEvent[] {
  return agent.session.snapshotEvents()
}

async function forkAt(fixture: Fixture, atSeq: SessionSeq): Promise<Agent> {
  const response = await createSessionTestRemote(fixture.ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/workspace',
  }).fork({ sessionId: fixture.source.id, atSeq })
  if (!response.ok) throw response.error
  const child = fixture.ctx.agents.get(response.value.sessionId)
  if (child === undefined) throw new Error('fork did not publish its child Agent')
  return child
}

const ids = (messages: readonly UserMessage[]) => messages.map(message => message.id)

describe('completedPrefixBefore', () => {
  it('keeps standalone events after the previous turn and excludes the opening splice', async () => {
    const fx = await fixture()
    fx.source.inbox.append('next-turn', prompt('one'))
    runTurn(fx, 1)
    const selection = fx.source.session.append('model/selection', { provider: 'p', model: 'next' })
    fx.source.inbox.append('next-turn', prompt('two'))
    runTurn(fx, 2)
    const events = eventsOf(fx.source)

    const cut = completedPrefixBefore(events, 2)

    expect(cut).toBe(selection.seq)
    if (cut === undefined) throw new Error('unreachable')
    expect(events[cut + 1]).toMatchObject({ type: 'agent/inbox/spliced', data: { target: 'next-turn' } })
    expect(inheritedNextTurnPrompts(events, cut)).toEqual([])
    const child = await forkAt(fx, cut)
    expect(child.inbox.nextTurn).toEqual([])
    expect(child.session.inheritedEventCount).toBe(cut + 1)
  })

  it('carries a prompt queued while the previous turn ran, which the branch removes', async () => {
    const fx = await fixture()
    const queued = prompt('queued while turn one ran')
    const later = prompt('queued for turn three')
    fx.source.inbox.append('next-turn', prompt('one'))
    runTurn(fx, 1, () => {
      fx.source.inbox.append('next-turn', queued)
      fx.source.inbox.append('next-turn', later)
    })
    const turnOneEnd = eventsOf(fx.source).at(-1)
    runTurn(fx, 2)
    const events = eventsOf(fx.source)

    const cut = completedPrefixBefore(events, 2)

    expect(cut).toBe(turnOneEnd?.seq)
    if (cut === undefined) throw new Error('unreachable')
    const inherited = inheritedNextTurnPrompts(events, cut)
    expect(ids(inherited)).toEqual([queued.id, later.id])
    const child = await forkAt(fx, cut)
    expect(ids(child.inbox.nextTurn)).toEqual(ids(inherited))
    for (const message of inherited) expect(child.inbox.remove(message.id)).toBe(true)
    expect(child.inbox.nextTurn).toEqual([])
    expect(ids(fx.source.inbox.nextTurn)).toEqual([later.id])
  })

  it('cuts turn 1 at the last standalone event before the first prompt splice', async () => {
    const fx = await fixture()
    fx.source.session.append('model/selection', { provider: 'p', model: 'first' })
    const last = fx.source.session.append('model/selection', { provider: 'p', model: 'second' })
    fx.source.inbox.append('next-turn', prompt('one'))
    runTurn(fx, 1)
    const events = eventsOf(fx.source)

    const cut = completedPrefixBefore(events, 1)

    expect(cut).toBe(last.seq)
    if (cut === undefined) throw new Error('unreachable')
    const child = await forkAt(fx, cut)
    expect(child.session.inheritedEventCount).toBe(2)
    expect(child.inbox.nextTurn).toEqual([])
  })

  it('has no cut for an absent turn or a first event that admits input', async () => {
    const fx = await fixture()
    fx.source.inbox.append('next-turn', prompt('one'))
    runTurn(fx, 1)
    const events = eventsOf(fx.source)

    expect(completedPrefixBefore(events, 1)).toBeUndefined()
    expect(completedPrefixBefore(events, 2)).toBeUndefined()
  })

  it('stops a standalone tail before an appended user message or a turn start', () => {
    const tail: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'model/selection', seq: SessionSeq(2), time: 2, data: { provider: 'p', model: 'm' } },
    ]
    const appended: SessionEvent = {
      type: 'user/message', seq: SessionSeq(3), time: 3, surfaceOp: 'append', data: prompt('appended'),
    }
    const nextTurn: SessionEvent = { type: 'turn/start', seq: SessionSeq(3), time: 3, data: { turn: 2 } }

    expect(completedPrefixBefore([...tail, appended, { ...nextTurn, seq: SessionSeq(4) }], 2)).toBe(2)
    expect(latestCompletedPrefixBoundary([...tail, appended])).toBe(2)
    expect(latestCompletedPrefixBoundary([...tail, nextTurn])).toBe(2)
    expect(latestCompletedPrefixBoundary(tail.slice(0, 1))).toBeUndefined()
  })
})

describe('inheritedNextTurnPrompts', () => {
  it('replays next-turn claims, cancellations, and replacements but ignores next-step input', async () => {
    const fx = await fixture()
    const first = prompt('first')
    const kept = prompt('kept')
    const canceled = prompt('canceled')
    const replaced = prompt('replaced')
    const replacement = prompt('replacement')
    for (const message of [first, canceled, replaced, kept]) fx.source.inbox.append('next-turn', message)
    fx.source.inbox.append('next-step', prompt('steer'))
    expect(fx.source.inbox.remove(canceled.id)).toBe(true)
    expect(fx.source.inbox.replace(replaced.id, replacement)).toBe(true)
    fx.source.session.append('turn/start', { turn: 1 })
    fx.loop.claim(fx.source, 'next-turn', 1)
    const events = eventsOf(fx.source)

    const pending = inheritedNextTurnPrompts(events, SessionSeq(events.length - 1))

    expect(ids(pending)).toEqual([replacement.id, kept.id])
    expect(ids(pending)).toEqual(ids(fx.source.inbox.nextTurn))
    expect(ids(inheritedNextTurnPrompts(events, SessionSeq(0)))).toEqual([first.id])
  })
})
