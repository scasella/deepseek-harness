/** Reader sources retain their Session only while observed; request sources read once per step and abort when unobserved. */
import { describe, expect, it, vi } from 'vitest'
import type { SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatSnapshot, TurnTailChatData } from '@deepseek-ai/dsh-client-ui-chat/client'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { LoomRequestView } from '@deepseek-ai/dsh-experimental-loom/types'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createLoomReaderSources, readerDocument, type LoomReaderState } from '../src/client/reader.ts'
import { createLoomRequestSources, loomRequestKey, type LoomRequestState } from '../src/client/requests.ts'

const SESSION = SessionId('session')

interface FakeTurn {
  readonly turn: number
  readonly startSeq?: number
  readonly status?: 'open' | 'closed' | 'unknown'
  readonly prompt?: string
  readonly tail?: Partial<TurnTailChatData>
}

/** A Chat snapshot carrying only what the reader folds: the timeline and per-Turn user and tail data. */
function chatOf(turns: readonly FakeTurn[]): ChatSnapshot {
  const byTurn = new Map(turns.map(turn => [turn.turn, turn]))
  function source<T>(value: readonly T[]): ObservableSnapshot<readonly T[]> {
    return { getSnapshot: () => value, subscribe: () => () => {} }
  }
  return {
    timeline: {
      turnOrder: turns.map(turn => turn.turn),
      turns: new Map(turns.map(turn => [turn.turn, {
        turn: turn.turn,
        start: turn.startSeq === undefined ? undefined : { seq: turn.startSeq },
        end: undefined,
        status: turn.status ?? 'closed',
        steps: [],
        data: {},
      }])),
    },
    nodes: {
      turnDataSource: (turn: number, kind: string) => {
        const fake = byTurn.get(turn)
        if (kind === 'user') {
          return source(fake?.prompt === undefined ? [] : [{ kind: 'user', seq: 0, time: 0, source: {}, content: [
            { type: 'text', text: fake.prompt },
            { type: 'image', attachment: {} },
          ] }])
        }
        return source(fake?.tail === undefined ? [] : [fake.tail])
      },
    },
  } as never
}

function tail(
  blocks: readonly ({ kind: 'text' | 'reasoning'; text: string; logprobs?: import('@deepseek-ai/dsh-llm/types').BlockTokenLogprobs } | { kind: 'other'; block: null })[],
  seq: number,
  reasoningTokens?: number,
  cacheReadTokens?: number,
): Partial<TurnTailChatData> {
  return {
    closing: { finalNode: { seq } , blocks } as never,
    ...reasoningTokens === undefined ? {} : {
      tokenUsage: {
        uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2, reasoningTokens,
        ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
      },
    },
  }
}

describe('Loom reader document', () => {
  it('retains captured answer probabilities and updates a turn when capture changes', () => {
    const probs = { tokens: ['r'], logprobs: [-1], top: [[]] }
    const make = (logprobs = probs) => chatOf([{ turn: 1, startSeq: 0, prompt: 'p', tail: tail([{ kind: 'text', text: 'r', logprobs }], 3) }])
    const first = readerDocument(make(), false)
    expect(first.turns[0]!.capturedReply).toEqual([{ text: 'r', logprobs: probs }])
    expect(readerDocument(make(), false, first)).toBe(first)
    expect(readerDocument(make({ ...probs }), false, first)).not.toBe(first)
    const shifted = { ...first, turns: [{ ...first.turns[0]!, capturedReply: [{ text: 'other', logprobs: probs }] }] }
    expect(readerDocument(make(), false, shifted)).not.toBe(shifted)
  })

  it('folds loaded turns into prompts, closing replies and reasoning, and request seqs', () => {
    const document = readerDocument(chatOf([
      { turn: 1, startSeq: 0, prompt: 'first', tail: tail([{ kind: 'reasoning', text: 'think' }, { kind: 'text', text: 'one' }, { kind: 'text', text: 'two' }, { kind: 'other', block: null }], 5, 42) },
      { turn: 2, status: 'open' },
    ]), true)
    expect(document).toEqual({
      hasMore: true,
      turns: [
        {
          turn: 1, startSeq: 0, prompt: 'first', reply: 'one\n\ntwo', reasoning: 'think', reasoningTokens: 42,
          usage: { inputTokens: 1, outputTokens: 1 }, closingSeq: 5, closed: true,
        },
        { turn: 2, prompt: '', reply: '', reasoning: '', closed: false },
      ],
    })
  })

  it('keeps unchanged turns and documents by reference', () => {
    const chat = chatOf([{ turn: 1, startSeq: 0, prompt: 'p', tail: tail([{ kind: 'text', text: 'r' }], 3) }, { turn: 2, startSeq: 9, prompt: 'q' }])
    const first = readerDocument(chat, false)
    expect(readerDocument(chat, false, first)).toBe(first)
    const grown = readerDocument(chatOf([
      { turn: 1, startSeq: 0, prompt: 'p', tail: tail([{ kind: 'text', text: 'r' }], 3) },
      { turn: 2, startSeq: 9, prompt: 'q', tail: tail([{ kind: 'text', text: 's' }], 12) },
    ]), false, first)
    expect(grown).not.toBe(first)
    expect(grown.turns[0]).toBe(first.turns[0])
    expect(readerDocument(chat, true, first)).not.toBe(first)
    expect(readerDocument(chatOf([{ turn: 1, startSeq: 0, prompt: 'p', tail: tail([{ kind: 'text', text: 'r' }], 3) }]), false, first).turns).toHaveLength(1)
  })

  it('carries a turn\'s usage and replaces a turn whose usage changes', () => {
    const counted = readerDocument(chatOf([{ turn: 1, startSeq: 0, prompt: 'p', tail: tail([{ kind: 'text', text: 'r' }], 3, 0, 40) }]), false)
    expect(counted.turns[0]?.usage).toEqual({ inputTokens: 1, cachedTokens: 40, outputTokens: 1 })
    expect(readerDocument(chatOf([{ turn: 1, startSeq: 0, prompt: 'p', tail: tail([{ kind: 'text', text: 'r' }], 3, 0, 40) }]), false, counted)).toBe(counted)
    const recounted = readerDocument(chatOf([{ turn: 1, startSeq: 0, prompt: 'p', tail: tail([{ kind: 'text', text: 'r' }], 3, 0, 41) }]), false, counted)
    expect(recounted.turns[0]).not.toBe(counted.turns[0])
    const uncounted = readerDocument(chatOf([{ turn: 1, startSeq: 0, prompt: 'p', tail: tail([{ kind: 'text', text: 'r' }], 3) }]), false, counted)
    expect(uncounted.turns[0]?.usage).toBeUndefined()
  })
})

/** A retained Session whose initial open the test settles, and whose Chat target and window the test drives. */
function retained() {
  let resolve!: (binding: SessionBinding) => void
  let reject!: (error: unknown) => void
  const ready = new Promise<SessionBinding>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  const release = vi.fn()
  const window = createSnapshotStore({ hasMore: false })
  // The reader reads only `hasMore` from the event window; the other binding members are unused.
  const binding: SessionBinding = { sessionId: SESSION, eventSource: window as never, session: {} as never, ctx: {} as never }
  const reference: SessionReference = { sessionId: SESSION, binding, ready, release, [Symbol.dispose]: release }
  return { reference, release, window, binding, open: () => { resolve(binding) }, fail: () => { reject(new Error('open failed')) } }
}

async function settled(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('Loom reader sources', () => {
  it('retains while observed, follows the Chat target, and releases on the last unsubscribe', async () => {
    const session = retained()
    const chat = createSnapshotStore<ChatSnapshot | undefined>(undefined)
    const retain = vi.fn(() => session.reference)
    const sources = createLoomReaderSources({ retain, chat: () => chat })
    const source = sources.source(SESSION)
    expect(sources.source(SESSION)).toBe(source)
    expect(source.getSnapshot()).toEqual({ status: 'loading' })
    const listener = vi.fn()
    const off = source.subscribe(listener)
    const second = source.subscribe(vi.fn())
    expect(retain).toHaveBeenCalledOnce()
    session.open()
    await settled()
    expect(source.getSnapshot()).toEqual({ status: 'loading' })
    chat.set(chatOf([{ turn: 1, startSeq: 0, prompt: 'hello' }]))
    const ready = source.getSnapshot() as Extract<LoomReaderState, { status: 'ready' }>
    expect(ready.document.turns[0]?.prompt).toBe('hello')
    expect(listener).toHaveBeenCalledOnce()
    chat.set(chatOf([{ turn: 1, startSeq: 0, prompt: 'hello' }]))
    expect(source.getSnapshot()).toBe(ready)
    off()
    off()
    expect(session.release).not.toHaveBeenCalled()
    second()
    expect(session.release).toHaveBeenCalledOnce()
    chat.set(chatOf([{ turn: 1, startSeq: 0, prompt: 'changed' }]))
    expect(source.getSnapshot()).toBe(ready)
    // The released source left the registry, so its document is not kept; a new lookup reads again.
    const fresh = sources.source(SESSION)
    expect(fresh).not.toBe(source)
    expect(fresh.getSnapshot()).toEqual({ status: 'loading' })
  })

  it('reports an unreadable Session, retries on the next observation, and ignores a superseded open', async () => {
    const failing = retained()
    const late = retained()
    const working = retained()
    const references = [failing, late, working]
    const chat = createSnapshotStore<ChatSnapshot | undefined>(chatOf([]))
    const sources = createLoomReaderSources({ retain: () => references.shift()!.reference, chat: () => chat })
    const source = sources.source(SESSION)
    const off = source.subscribe(vi.fn())
    failing.fail()
    await settled()
    expect(source.getSnapshot()).toEqual({ status: 'failed' })
    off()
    const offLate = source.subscribe(vi.fn())
    expect(source.getSnapshot()).toEqual({ status: 'loading' })
    offLate()
    late.open()
    await settled()
    expect(source.getSnapshot()).toEqual({ status: 'loading' })
    source.subscribe(vi.fn())
    late.fail()
    working.open()
    await settled()
    expect(source.getSnapshot()).toMatchObject({ status: 'ready', document: { turns: [], hasMore: false } })
    const stale = retained()
    const staleSources = createLoomReaderSources({ retain: () => stale.reference, chat: () => chat })
    const staleOff = staleSources.source(SESSION).subscribe(vi.fn())
    staleOff()
    stale.fail()
    await settled()
    expect(staleSources.source(SESSION).getSnapshot()).toEqual({ status: 'loading' })
    sources.dispose()
    expect(working.release).toHaveBeenCalledOnce()
  })
})

const VIEW: LoomRequestView = {
  route: { provider: 'deepseek', model: 'v4' },
  systemPrompt: { chars: 10, text: 'be helpful' },
  tools: { names: ['read'], addedThisTurn: [], removedThisTurn: [] },
  messages: [],
  inheritedTurns: 0,
  ownTurns: 1,
}

describe('Loom request sources', () => {
  it('reads one step once while observed, parses its key, and reads again after the last observer left', async () => {
    const read = vi.fn((_request: unknown, _signal: AbortSignal): Promise<RemoteResult<LoomRequestView>> =>
      Promise.resolve({ ok: true, value: VIEW }))
    const sources = createLoomRequestSources({ read })
    const key = loomRequestKey(SESSION, 7)
    expect(key).toBe('session:7')
    const source = sources.source(key)
    expect(sources.source(key)).toBe(source)
    const listener = vi.fn()
    const off = source.subscribe(listener)
    source.subscribe(vi.fn())()
    expect(read).toHaveBeenCalledWith({ sessionId: SESSION, seq: SessionSeq(7) }, expect.any(AbortSignal))
    await settled()
    expect(source.getSnapshot()).toEqual({ status: 'ready', view: VIEW })
    expect(listener).toHaveBeenCalledOnce()
    off()
    off()
    // A render that still held the dropped source observes it again without a second read.
    const again = source.subscribe(vi.fn())
    expect(read).toHaveBeenCalledOnce()
    expect(sources.source(key)).toBe(source)
    again()
    const fresh = sources.source(key)
    expect(fresh).not.toBe(source)
    expect(fresh.getSnapshot()).toEqual({ status: 'loading' })
    fresh.subscribe(vi.fn())
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('reports typed failures and rejected calls, retrying on the next observation', async () => {
    const results: Promise<RemoteResult<LoomRequestView>>[] = [
      Promise.resolve({ ok: false, error: new RemoteError('session/not-found', 'gone', { sessionId: SESSION }) }),
      Promise.reject(new Error('not mounted')),
    ]
    const read = vi.fn(() => results.shift()!)
    const source = createLoomRequestSources({ read }).source(loomRequestKey(SESSION, 3))
    const off = source.subscribe(vi.fn())
    await settled()
    expect(source.getSnapshot()).toEqual({ status: 'failed', code: 'session/not-found' })
    off()
    const states: LoomRequestState[] = []
    source.subscribe(() => { states.push(source.getSnapshot()) })
    expect(source.getSnapshot()).toEqual({ status: 'loading' })
    await settled()
    expect(states.at(-1)).toEqual({ status: 'failed' })
  })

  it('aborts a pending read when unobserved and drops its late result', async () => {
    let finish!: (result: RemoteResult<LoomRequestView>) => void
    let fail!: (error: unknown) => void
    const signals: AbortSignal[] = []
    const read = vi.fn((_request: unknown, signal: AbortSignal) => {
      signals.push(signal)
      return signals.length === 1
        ? new Promise<RemoteResult<LoomRequestView>>((resolve) => { finish = resolve })
        : new Promise<RemoteResult<LoomRequestView>>((_resolve, reject) => { fail = reject })
    })
    const sources = createLoomRequestSources({ read })
    const source = sources.source(loomRequestKey(SESSION, 4))
    source.subscribe(vi.fn())()
    expect(signals[0]?.aborted).toBe(true)
    finish({ ok: true, value: VIEW })
    await settled()
    expect(source.getSnapshot()).toEqual({ status: 'loading' })
    source.subscribe(vi.fn())
    sources.dispose()
    expect(signals[1]?.aborted).toBe(true)
    fail(new Error('aborted'))
    await settled()
    expect(source.getSnapshot()).toEqual({ status: 'loading' })
  })
})
