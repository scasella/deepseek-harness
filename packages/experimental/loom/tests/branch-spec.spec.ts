/** Branch resolution over hand-written logs: cases the agent loop does not write. */
import { completedPrefixBefore } from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type SessionEvent, type SessionHeader, type UserMessage } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { editedContent, resolveBranch, variantKeyOf, type LoomBranchPolicy } from '../src/branch-spec.ts'
import type { LoomBranchRequest, LoomBranchRequestId } from '../src/types.ts'

const SOURCE = SessionId('hand-written')
const header = { id: SOURCE } as SessionHeader
const POLICY: LoomBranchPolicy = { maxBranchesPerRequest: 8, defaultSandboxMode: undefined, redirect: true }

function log(...events: readonly Pick<SessionEvent, 'type' | 'data'>[]): SessionEvent[] {
  return events.map((event, seq) => ({ ...event, seq: SessionSeq(seq), time: seq }) as SessionEvent)
}

describe('resolveBranch', () => {
  it('refuses a steer whose next turn started before the turn it follows ended', () => {
    const events = log(
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    )
    expect(() => resolveBranch(
      { sessionId: SOURCE, requestId: brandString<LoomBranchRequestId>('r'), kind: 'steer', afterTurn: 1, lines: ['a'] },
      { meta: header, inheritedEventCount: 0, events },
      POLICY,
    )).toThrow(expect.objectContaining({ code: 'loom/turn-unavailable', details: { sessionId: SOURCE, turn: 1, reason: 'no-cut' } }))
  })

  describe('a regenerate or edit of a fork', () => {
    const PARENT = SessionId('hand-written-parent')
    const own = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    const inherited = own('inherited')
    const first = own('first own')
    const second = own('second own')
    /** One user-opened turn: the prompt queued, the turn started, the prompt admitted, the turn ended. */
    const turn = (number: number, message: UserMessage): Pick<SessionEvent, 'type' | 'data'>[] => [
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [message] } },
      { type: 'turn/start', data: { turn: number } },
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
      { type: 'user/message', data: message },
      { type: 'turn/end', data: { turn: number, reason: { kind: 'completed' } } },
    ]
    // seq 0-5 inherited (a standalone event and turn 1), 6 the fork's own standalone event, 7-11 turn 2, 12-16 turn 3.
    const events = log(
      { type: 'sandbox/mode', data: { mode: 'read-only' } },
      ...turn(1, inherited),
      { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      ...turn(2, first),
      ...turn(3, second),
    )
    const fork = { id: SOURCE, parentSession: PARENT, isSeeded: true } as SessionHeader
    const base = { sessionId: SOURCE, requestId: brandString<LoomBranchRequestId>('r') }
    const request = (turnNumber: number): LoomBranchRequest => ({ ...base, kind: 'regenerate', turn: turnNumber, count: 1 })

    it('branches the first own turn from the fork parent at the fork cut, with the fork\'s prompt', () => {
      const regenerated = resolveBranch(request(2), { meta: fork, inheritedEventCount: 6, events }, POLICY)
      expect(regenerated).toMatchObject({
        sourceSessionId: PARENT, cut: 5, children: [{ index: 0, content: first.content }], writable: false,
      })
      expect(regenerated).not.toHaveProperty('selection')
      expect(resolveBranch({ ...base, kind: 'edit', turn: 2, text: 'edited' }, { meta: fork, inheritedEventCount: 6, events }, POLICY))
        .toMatchObject({ sourceSessionId: PARENT, cut: 5, children: [{ index: 0, content: [{ type: 'text', text: 'edited' }] }] })
    })

    it('routes first-own-turn children by the last selection the fork logged before that turn, unless the request names one', () => {
      const route = (model: string, reasoningEffort?: string): Pick<SessionEvent, 'type' | 'data'> => ({
        type: 'model/selection', data: { provider: 'p', model, ...reasoningEffort === undefined ? {} : { reasoningEffort } },
      })
      // seq 0-5 inherited (a pick and turn 1), 6-7 the fork's own picks, 8-12 turn 2, 13 a pick after it.
      const routed = log(route('inherited'), ...turn(1, inherited), route('fork-route'), route('picked', 'high'), ...turn(2, first), route('later'))
      const source = { meta: fork, inheritedEventCount: 6, events: routed }
      expect(resolveBranch(request(2), source, POLICY).selection).toEqual({ provider: 'p', model: 'picked', reasoningEffort: 'high' })
      expect(resolveBranch({ ...base, kind: 'edit', turn: 2, text: 'edited' }, source, POLICY).selection)
        .toEqual({ provider: 'p', model: 'picked', reasoningEffort: 'high' })
      const named = { provider: 'q', model: 'named' }
      expect(resolveBranch({ ...request(2), selection: named }, source, POLICY).selection).toEqual(named)
      // seq 0-5 inherited, 6-10 turn 2: the inherited pick and the one after the turn route nothing.
      const unrouted = log(route('inherited'), ...turn(1, inherited), ...turn(2, first), route('later'))
      expect(resolveBranch(request(2), { meta: fork, inheritedEventCount: 6, events: unrouted }, POLICY)).not.toHaveProperty('selection')
    })

    it('cuts the first own turn in the addressed fork, below it, when the policy does not redirect', () => {
      const source = { meta: fork, inheritedEventCount: 6, events }
      const policy = { ...POLICY, redirect: false }
      for (const kind of ['regenerate', 'edit'] as const) {
        const spec = resolveBranch(kind === 'edit' ? { ...base, kind, turn: 2, text: 'edited' } : request(2), source, policy)
        expect(spec, kind).toMatchObject({ sourceSessionId: SOURCE, cut: completedPrefixBefore(events, 2) })
        expect(spec, kind).not.toHaveProperty('selection')
      }
      // The first own prompt is still the one resent, from the addressed fork's own log.
      expect(resolveBranch(request(2), source, policy).children).toMatchObject([{ index: 0, content: first.content }])
    })

    it('cuts in the addressed Session for any other turn or Session', () => {
      const cases: readonly [string, SessionHeader, number, number][] = [
        ['a later own turn', fork, 6, 3],
        ['an inherited turn', fork, 6, 1],
        ['a fork with no own turn yet', fork, 17, 3],
        ['a subagent child', { ...fork, origin: 'subagent' }, 6, 2],
        ['a Session with a parent but no inherited events', fork, 0, 2],
        ['a Session that is not a fork', header, 0, 2],
      ]
      for (const [name, meta, inheritedEventCount, turnNumber] of cases) {
        const spec = resolveBranch(request(turnNumber), { meta, inheritedEventCount, events }, POLICY)
        expect(spec, name).toMatchObject({ sourceSessionId: SOURCE, cut: completedPrefixBefore(events, turnNumber) })
      }
    })
  })
})

describe('editedContent', () => {
  const image = { type: 'image', attachment: { attachmentId: 'a' } } as never
  const file = { type: 'file', attachment: { attachmentId: 'f' } } as never

  it('replaces every text part with one at the position of the first and keeps attachments in order', () => {
    expect(editedContent([image, { type: 'text', text: 'one' }, file, { type: 'text', text: 'two' }], 'new'))
      .toEqual([image, { type: 'text', text: 'new' }, file])
  })

  it('puts the text first in a prompt without text', () => {
    expect(editedContent([image], 'new')).toEqual([{ type: 'text', text: 'new' }, image])
  })
})

describe('variantKeyOf', () => {
  it('derives a short stable key from the exact line', () => {
    expect(variantKeyOf('a')).toBe('ca978112ca1bbdca')
    expect(variantKeyOf('a ')).not.toBe(variantKeyOf('a'))
  })
})
