import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { parseSessionLog, prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import {
  assertFixtureInventory,
  parseSeedFixture,
  recordedSessionFixturePath,
  seedFork,
  seedForkFamily,
  selectedSessionFixture,
  type SeedTarget,
} from './scaffold.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Web seed stream timing', () => {
  it.each([2, 3])('preserves embedded timestamps from format v%i and its current projection', async (version) => {
    const fixture = await readFile(new URL(`../../../snapshots/session/skill-load/session.v${version}.jsonl`, import.meta.url), 'utf8')
    const current = prepareSessionSnapshotFixtureForComparison(fixture)
    const expected = parseSessionLog(current)

    expect(parseSeedFixture(fixture).events).toEqual(expected)
    expect(parseSeedFixture(current).events).toEqual(expected)
  })

  it.each(['session.jsonl', 'session.v1.jsonl'])('reconstructs positive stream intervals from %s', async (filename) => {
    const fixture = await readFile(new URL(`../../../snapshots/session/text-turn/${filename}`, import.meta.url), 'utf8')
    const messages = parseSeedFixture(fixture).events.filter(event => event.type === 'assistant/message')
    expect(messages).toHaveLength(1)
    const stream = messages[0]!.data.stream
    expect(stream.length).toBeGreaterThan(1)

    let previousEnd = -1
    for (const record of stream) {
      const start = 'time' in record ? record.time : record.time0
      expect(start).toBeGreaterThan(previousEnd)
      previousEnd = 'time' in record ? record.time : record.time0 + record.dt.reduce((total, delta) => total + delta, 0)
    }
    expect(previousEnd).toBeGreaterThan(0)
  })
})

describe('Web snapshot generation filenames', () => {
  it('selects the highest parent and child generations without counting retained inputs twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-generations-'))
    roots.push(root)
    for (const [name, version] of [
      ['session.jsonl', 0],
      ['session.v2.jsonl', 2],
      ['session.1.jsonl', 0],
      ['session.1.v1.jsonl', 1],
    ] as const) {
      await writeFile(join(root, name), `${JSON.stringify({
        type: 'session', version, id: '{{session:1}}', createdAt: 0, delegationDepth: 0,
      })}\n`)
    }

    await expect(selectedSessionFixture(join(root, 'session.jsonl')))
      .resolves.toBe(join(root, 'session.v2.jsonl'))
    await expect(selectedSessionFixture(join(root, 'session.1.jsonl')))
      .resolves.toBe(join(root, 'session.1.v1.jsonl'))
    await expect(selectedSessionFixture(join(root, 'replay.override.json')))
      .resolves.toBe(join(root, 'replay.override.json'))
  })

  it('leaves an absent override-only parent fixture unresolved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-generations-'))
    roots.push(root)

    await expect(selectedSessionFixture(join(root, 'session.jsonl'), true))
      .resolves.toBe(join(root, 'session.jsonl'))
    await expect(selectedSessionFixture(join(root, 'session.jsonl')))
      .rejects.toThrow('missing parent session fixture')
  })

  it('records beside an older generation and preserves the parent or child role', () => {
    const fixtures = join('/', 'fixtures')
    expect(recordedSessionFixturePath(join(fixtures, 'session.jsonl'), 1))
      .toBe(join(fixtures, 'session.v1.jsonl'))
    expect(recordedSessionFixturePath(join(fixtures, 'session.2.jsonl'), 3))
      .toBe(join(fixtures, 'session.2.v3.jsonl'))
    expect(recordedSessionFixturePath(join(fixtures, 'session.v1.jsonl'), 1))
      .toBe(join(fixtures, 'session.v1.jsonl'))
    expect(() => recordedSessionFixturePath(join(fixtures, 'notes.jsonl'), 1))
      .toThrow('invalid Session fixture path')
  })

  it('treats retained generations as one exact inventory role', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-fixture-inventory-'))
    roots.push(root)
    await writeFile(join(root, 'session.jsonl'), `${JSON.stringify({
      type: 'session', version: 0, id: '{{session:1}}', createdAt: 0, delegationDepth: 0,
    })}\n`)
    await writeFile(join(root, 'session.v1.jsonl'), `${JSON.stringify({
      type: 'session', version: 1, id: '{{session:1}}', createdAt: 0, delegationDepth: 0,
    })}\n`)
    await writeFile(join(root, 'ui.expected.md'), 'stable\n')

    await expect(assertFixtureInventory(root, ['session.jsonl', 'ui.expected.md']))
      .resolves.toBeUndefined()
  })
})

/** One stored Session read back through an independent JSONL provider. */
interface StoredSeed {
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly events: readonly SessionEvent[]
}

async function seedTarget(): Promise<SeedTarget> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-fork-seed-'))
  roots.push(root)
  return {
    persistenceRoot: join(root, 'sessions'),
    workspaceCwd: join(root, 'workspace'),
    harnessHome: join(root, 'home'),
  }
}

async function readStored(target: SeedTarget, id: SessionId): Promise<StoredSeed> {
  const reader = new Context()
  try {
    await reader.plugin(JsonlSessionPersistence, { root: target.persistenceRoot })
    const handle = await reader.sessionPersistence.open(id, 'read')
    try {
      return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: (await handle.read()).events }
    } finally {
      await handle.close()
    }
  } finally {
    await reader.fiber.dispose()
  }
}

/** The child the in-memory SessionStore.fork builds from the same stored parent and cut. */
async function storeFork(parent: StoredSeed, atSeq: number): Promise<StoredSeed> {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    const source = ctx.sessions.create(parent.header.id, { seed: parent.events, meta: parent.header })
    const child = ctx.sessions.fork(source, SessionSeq(atSeq), SessionId('store-fork'))
    return { header: child.header, inheritedEventCount: child.inheritedEventCount, events: child.snapshotEvents() }
  } finally {
    await ctx.fiber.dispose()
  }
}

function seqOf(events: readonly SessionEvent[], type: SessionEvent['type'], turn: number): number {
  const event = events.find(candidate => candidate.type === type && 'turn' in candidate.data && candidate.data.turn === turn)
  if (event === undefined) throw new Error(`missing ${type} for turn ${String(turn)}`)
  return event.seq
}

function appendClosedTurn(child: Session, turn: number, text: string): void {
  child.append('turn/start', { turn })
  child.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  child.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('Web fork-family seeding', () => {
  const parentFixture = createChatScrollFixture({ markerPrefix: 'FORKSEED', title: 'Fork seed family', turns: 8 })

  it('stores each child with the lineage header, inherited prefix, and cut marker that session.fork stores', async () => {
    const target = await seedTarget()
    const atSeq = seqOf(parseSeedFixture(parentFixture.log).events, 'turn/end', 1)
    const createdAt = Date.now()

    const { root, forks } = await seedForkFamily(target, { fixtureText: parentFixture.log, id: 'fork-root', agentPreset: 'standard' }, [
      { id: 'sibling-a', atSeq, createdAt, continueWith: (child) => { appendClosedTurn(child, 2, 'branch A') } },
      { id: 'sibling-b', atSeq },
      { id: 'grandchild', parent: 'sibling-a', atSeq: atSeq + 4, agentPreset: 'minimal' },
    ])
    expect(root).toBe(SessionId('fork-root'))
    expect(forks).toEqual([SessionId('sibling-a'), SessionId('sibling-b'), SessionId('grandchild')])

    const parent = await readStored(target, root)
    const cut = parent.events[atSeq]!
    const siblingA = await readStored(target, SessionId('sibling-a'))
    const siblingB = await readStored(target, SessionId('sibling-b'))
    for (const child of [siblingA, siblingB]) {
      expect(child.header).toMatchObject({
        parentSession: root,
        isSeeded: true,
        cwd: target.workspaceCwd,
        delegationDepth: 0,
        agentPreset: 'standard',
      })
      expect(child.inheritedEventCount).toBe(atSeq + 1)
      expect(child.events.slice(0, atSeq + 1)).toEqual(parent.events.slice(0, atSeq + 1))
      expect(child.events[atSeq + 1]).toEqual({
        type: 'session/end-seed', seq: atSeq + 1, time: cut.time, data: { inherited: true },
      })
    }
    expect(siblingB.events).toHaveLength(atSeq + 2)
    expect(siblingB.header.createdAt).toBe(cut.time + 1)
    expect(siblingA.header.createdAt).toBe(createdAt)
    expect(siblingA.events.slice(atSeq + 2).map(event => [event.type, event.seq, event.time])).toEqual([
      ['turn/start', atSeq + 2, createdAt],
      ['user/message', atSeq + 3, createdAt + 1],
      ['turn/end', atSeq + 4, createdAt + 2],
    ])

    const store = await storeFork(parent, atSeq)
    expect(siblingB.events).toEqual(store.events)
    expect(siblingB.inheritedEventCount).toBe(store.inheritedEventCount)
    expect(store.header).toMatchObject({ parentSession: root, isSeeded: true, cwd: siblingB.header.cwd })

    const grandchild = await readStored(target, SessionId('grandchild'))
    expect(grandchild.header).toMatchObject({ parentSession: SessionId('sibling-a'), isSeeded: true, agentPreset: 'minimal' })
    expect(grandchild.inheritedEventCount).toBe(atSeq + 5)
    expect(grandchild.events.slice(0, atSeq + 5)).toEqual(siblingA.events)
    expect(grandchild.events.filter(event => event.type === 'session/end-seed').map(event => event.data))
      .toEqual([{ inherited: true }, { inherited: true }])
  })

  it('closes a cut inside a turn with the forked closers session.fork appends', async () => {
    const target = await seedTarget()
    const parentId = SessionId('fork-open-root')
    await seedForkFamily(target, { fixtureText: parentFixture.log, id: parentId, agentPreset: 'standard' }, [])
    const parent = await readStored(target, parentId)
    const atSeq = parent.events.find(event => event.type === 'tool/call')!.seq

    const childId = await seedFork(target, parentId, 'open-cut', {
      atSeq, continueWith: (child) => { appendClosedTurn(child, 9, 'after the cut') },
    })
    const child = await readStored(target, childId)
    const seed = (await storeFork(parent, atSeq)).events

    expect(child.inheritedEventCount).toBe(atSeq + 1)
    expect(child.events.slice(0, seed.length)).toEqual(seed)
    expect(seed.slice(atSeq + 2).map(event => event.type)).toEqual(['tool/result', 'tool/result', 'step/end', 'turn/end'])
    expect(child.events.slice(seed.length).map(event => event.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
  })

  it('refuses a missing cut, a creation time before the cut, and an open continuation', async () => {
    const target = await seedTarget()
    const parentId = SessionId('fork-refusal-root')
    await seedForkFamily(target, { fixtureText: parentFixture.log, id: parentId, agentPreset: 'standard' }, [])
    const parent = await readStored(target, parentId)
    const last = parent.events.at(-1)!
    const atSeq = seqOf(parent.events, 'turn/end', 1)

    await expect(seedFork(target, parentId, 'missing-cut', { atSeq: last.seq + 1 }))
      .rejects.toThrow(`event ${String(last.seq + 1)} does not exist in session "${parentId}" (last seq: ${String(last.seq)})`)
    await expect(seedFork(target, parentId, 'early-child', { atSeq, createdAt: parent.events[atSeq]!.time - 1 }))
      .rejects.toThrow('precedes its cut event time')
    await expect(seedFork(target, parentId, 'open-child', {
      atSeq, continueWith: (child) => { child.append('turn/start', { turn: 2 }) },
    })).rejects.toThrow('fork continuation must end in turn/end, got turn/start')
  })

  it('refuses a parent without an agent preset unless the caller names one', async () => {
    const target = await seedTarget()
    const parentId = SessionId('fork-presetless-root')
    await seedForkFamily(target, { fixtureText: parentFixture.log, id: parentId }, [])
    const atSeq = seqOf((await readStored(target, parentId)).events, 'turn/end', 1)

    await expect(seedFork(target, parentId, 'presetless-child', { atSeq }))
      .rejects.toThrow(`session "${parentId}" records no agent preset`)
    const childId = await seedFork(target, parentId, 'named-preset-child', { atSeq, agentPreset: 'standard' })
    expect((await readStored(target, childId)).header.agentPreset).toBe('standard')
  })
})
