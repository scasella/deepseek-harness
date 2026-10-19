/** The Session Controller's `forkLineage` projection: header parent, inherited cut, and last inherited turn. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import type { ForkLineageProjection, SessionFollowFrame } from '../src/types.ts'
import { forkLineageProjectionDefinition } from '../src/fork-lineage-projection.ts'
import { createSessionTestRemote, testSessionPersistence, type TestSessionRemote } from './test-remote.ts'

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  try {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  } finally {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  }
})

const defaults = { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/workspace' }

async function host(): Promise<{ ctx: Context; remote: TestSessionRemote }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  return { ctx, remote: createSessionTestRemote(ctx, defaults) }
}

/** Append `turns` completed turns, each with one step, to a live Session. */
function completeTurns(session: Session, from: number, turns: number): void {
  for (let turn = from; turn < from + turns; turn++) {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
}

function lastSeqOf(session: Session, type: SessionEvent['type']): SessionSeq {
  const event = session.snapshotEvents().findLast(candidate => candidate.type === type)
  if (event === undefined) throw new Error(`no ${type} event`)
  return event.seq
}

function lineageOf(ctx: Context, session: Session): ForkLineageProjection | undefined {
  return ctx.sessionProjections.snapshot(session).values.forkLineage
}

async function opening(remote: TestSessionRemote, sessionId: SessionId): Promise<Extract<SessionFollowFrame, { type: 'snapshot' }>> {
  const abort = new AbortController()
  const iterator = remote.follow({ address: { kind: 'session', sessionId } }, abort.signal)[Symbol.asyncIterator]()
  const first = await iterator.next()
  abort.abort()
  await iterator.return?.()
  if (first.done || first.value.type !== 'snapshot') throw new Error('follow did not open with a snapshot')
  return first.value
}

describe('forkLineage projection', () => {
  it('projects only the creation time for a Session without a parent', async () => {
    const { ctx } = await host()
    const session = ctx.sessions.create(SessionId('lineage-root'), { meta: { cwd: '/workspace', createdAt: 7 } })
    completeTurns(session, 1, 1)

    expect(lineageOf(ctx, session)).toEqual({ createdAt: 7 })
  })

  it('projects the header parent without a cut for an unseeded child', async () => {
    const { ctx } = await host()
    const child = ctx.sessions.create(SessionId('lineage-subagent'), {
      meta: { cwd: '/workspace', createdAt: 9, parentSession: SessionId('lineage-caller'), origin: 'subagent' },
    })

    expect(lineageOf(ctx, child)).toEqual({ parentSession: 'lineage-caller', createdAt: 9 })
  })

  it('serves the parent, cut, and last inherited turn of a fork through follow and list', async () => {
    const { ctx, remote } = await host()
    const parent = ctx.sessions.create(SessionId('lineage-parent'), { meta: { cwd: '/workspace' } })
    completeTurns(parent, 1, 1)
    parent.append('model/selection', { provider: 'p', model: 'next' })
    const cut = SessionSeq(parent.seq - 1)
    completeTurns(parent, 2, 1)
    const child = ctx.sessions.fork(parent, cut, SessionId('lineage-child'))
    const expected: ForkLineageProjection = {
      parentSession: parent.id, cutSeq: cut, cutTurn: 1, createdAt: child.header.createdAt,
    }

    expect(lineageOf(ctx, child)).toEqual(expected)
    const folded = ctx.sessionProjections.stateOf(child, 'forkLineage')
    completeTurns(child, 2, 1)
    expect(ctx.sessionProjections.stateOf(child, 'forkLineage')).toBe(folded)
    expect((await opening(remote, child.id)).projections.values.forkLineage).toEqual(expected)
    const listing = await remote.list({})
    if (!listing.ok) throw listing.error
    const row = listing.value.items.find(item => item.sessionId === child.id)
    expect(row?.projections).toMatchObject({ kind: 'sequenced', values: { forkLineage: expected } })
  })

  it('reports the last completed turn for a mid-turn cut and none before the first turn end', async () => {
    const { ctx } = await host()
    const parent = ctx.sessions.create(SessionId('lineage-open-parent'), { meta: { cwd: '/workspace' } })
    completeTurns(parent, 1, 1)
    parent.append('turn/start', { turn: 2 })
    const inside = parent.append('step/start', { turn: 2, step: 1 })
    const midTurn = ctx.sessions.fork(parent, inside.seq, SessionId('lineage-mid-turn'))
    const beforeFirstEnd = ctx.sessions.fork(parent, SessionSeq(0), SessionId('lineage-turn-one'))

    expect(lineageOf(ctx, midTurn)).toMatchObject({ cutSeq: inside.seq, cutTurn: 1 })
    expect(lastSeqOf(midTurn, 'turn/end')).toBeGreaterThan(inside.seq)
    expect(lineageOf(ctx, beforeFirstEnd)).toEqual({
      parentSession: parent.id, cutSeq: 0, createdAt: beforeFirstEnd.header.createdAt,
    })
  })

  it('reports the grandchild cut and turn after a fork of a fork', async () => {
    const { ctx } = await host()
    const root = ctx.sessions.create(SessionId('lineage-grand-root'), { meta: { cwd: '/workspace' } })
    completeTurns(root, 1, 1)
    const child = ctx.sessions.fork(root, lastSeqOf(root, 'turn/end'), SessionId('lineage-grand-child'))
    completeTurns(child, 2, 1)
    const grandchild = ctx.sessions.fork(child, lastSeqOf(child, 'turn/end'), SessionId('lineage-grandchild'))

    const lineage = lineageOf(ctx, grandchild)
    expect(lineage).toEqual({
      parentSession: child.id,
      cutSeq: grandchild.inheritedEventCount - 1,
      cutTurn: 2,
      createdAt: grandchild.header.createdAt,
    })
    const markers = grandchild.snapshotEvents()
      .filter(event => event.type === 'session/end-seed' && event.data.inherited === true)
      .map(event => event.seq)
    expect(markers).toEqual([child.inheritedEventCount, grandchild.inheritedEventCount])
    expect(markers.at(-1)).toBe((lineage?.cutSeq ?? -1) + 1)
  })

  it('projects a parent without a cut for a fork of an empty Session', async () => {
    const { ctx } = await host()
    const empty = ctx.sessions.create(SessionId('lineage-empty'), { meta: { cwd: '/workspace' } })
    const child = ctx.sessions.fork(empty, undefined, SessionId('lineage-empty-child'))

    expect(child.header.isSeeded).toBe(true)
    expect(lineageOf(ctx, child)).toEqual({ parentSession: empty.id, createdAt: child.header.createdAt })
  })

  it('restores a fork lineage from a checkpoint row folded partway through the inherited prefix', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(forkLineageProjectionDefinition)
    const parent = ctx.sessions.create(SessionId('lineage-restore-parent'), { meta: { cwd: '/workspace' } })
    completeTurns(parent, 1, 2)
    const child = ctx.sessions.fork(parent, lastSeqOf(parent, 'turn/end'), SessionId('lineage-restore-child'))
    const events = child.snapshotEvents()
    const firstTurnEnd = events.findIndex(event => event.type === 'turn/end')
    const partial = events.slice(0, firstTurnEnd + 1).reduce(
      forkLineageProjectionDefinition.apply,
      forkLineageProjectionDefinition.init(child.header, child.inheritedEventCount),
    )
    const row = { ver: forkLineageProjectionDefinition.stateVersion, seq: SessionSeq(firstTurnEnd), val: partial }

    const restored = ctx.sessionProjections.restore(
      { forkLineage: row },
      events.slice(firstTurnEnd + 1),
      SessionLogOffset(firstTurnEnd + 1),
      child.header,
      child.inheritedEventCount,
    )

    expect(partial.cutTurn).toBe(1)
    expect(restored.snapshot.values.forkLineage).toEqual(lineageOf(ctx, child))
    expect(restored.snapshot.values.forkLineage).toMatchObject({ cutTurn: 2 })
  })

  it('lists a cold fork lineage from the projection cache after a Host restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-fork-lineage-'))
    roots.push(root)
    const boot = async (): Promise<Context> => {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root })
      await ctx.plugin(StorageDomain, { backend: 'json' })
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
      return ctx
    }

    const first = await boot()
    createSessionTestRemote(first, defaults)
    await new Promise(resolve => setTimeout(resolve, 0))
    const parent = first.sessions.create(SessionId('lineage-cold-parent'), { meta: { cwd: '/workspace' } })
    completeTurns(parent, 1, 1)
    const child = first.sessions.fork(parent, lastSeqOf(parent, 'turn/end'), SessionId('lineage-cold-child'))
    const expected = lineageOf(first, child)
    await first.sessionProjectionCache.write(child)
    const header = child.header
    await first.fiber.dispose()

    const second = await boot()
    const remote = createSessionTestRemote(second, defaults)
    await new Promise(resolve => setTimeout(resolve, 0))
    const load = () => { throw new Error('a cold fork listing must not load the event log') }
    second.provide('sessionPersistence', testSessionPersistence(second, {
      list: async () => [header],
      inspect: load,
      open: load,
    }) as never)

    const listing = await remote.list({})
    if (!listing.ok) throw listing.error
    const row = listing.value.items.find(item => item.sessionId === header.id)
    expect(expected).toMatchObject({ parentSession: parent.id, cutTurn: 1 })
    expect(row?.projections).toMatchObject({ kind: 'cached', values: { forkLineage: expected } })
  })

  it('removes the forkLineage key when the controller fiber unloads', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionProjectionRegistry)
    const session = ctx.sessions.create(SessionId('lineage-unload'), { meta: { cwd: '/workspace', createdAt: 3 } })
    expect('forkLineage' in ctx.sessionProjections.snapshot(session).values).toBe(false)
    const fiber = ctx.plugin(Object.assign((controllerCtx: Context) => {
      createSessionTestRemote(controllerCtx, defaults)
    }, { inject: ['sessions', 'agents', 'sessionProjections'] }))
    await fiber.await()
    await vi.waitFor(() => {
      expect(lineageOf(ctx, session)).toEqual({ createdAt: 3 })
    })

    await fiber.dispose()

    expect('forkLineage' in ctx.sessionProjections.snapshot(session).values).toBe(false)
  })
})
