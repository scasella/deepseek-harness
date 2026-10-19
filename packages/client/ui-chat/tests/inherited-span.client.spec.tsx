// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type {
  ConversationTimelineSnapshot, GroupKey, NodeKey, RenderEntry, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatConversationViewNode } from '../src/client/contract/chat-nodes.ts'
import { forkCutOf, inheritedEntryCount, lastInheritedTurn } from '../src/client/chat/inherited-span.ts'
import { InheritedSpanRow } from '../src/client/chat/InheritedSpanRow.tsx'
import { en, zh } from '../src/client/locale.ts'

afterEach(() => { cleanup() })

const PARENT = 'parent' as SessionId

function turn(number: number, startSeq?: number): TurnLocation {
  return {
    turn: number,
    start: startSeq === undefined ? undefined : { type: 'turn/start', seq: SessionSeq(startSeq), time: 0, data: { turn: number } },
    end: undefined,
    status: 'closed',
    steps: [],
    data: { get: () => undefined, source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) } as never,
  }
}

function timeline(...turns: TurnLocation[]): ConversationTimelineSnapshot {
  return { turnOrder: turns.map(location => location.turn), turns: new Map(turns.map(location => [location.turn, location])) }
}

function node(key: string, anchorSeq: number, location: ChatConversationViewNode['location']): ChatConversationViewNode {
  return { key, id: key, target: 'chat', kind: 'user', anchorSeq, location, visibility: 'visible', data: {} } as never
}

describe('forkCutOf', () => {
  it('requires both a parent and an inherited prefix', () => {
    expect(forkCutOf(undefined)).toBeUndefined()
    expect(forkCutOf({ createdAt: 1 })).toBeUndefined()
    expect(forkCutOf({ parentSession: PARENT, createdAt: 1 })).toBeUndefined()
    expect(forkCutOf({ cutSeq: SessionSeq(3), createdAt: 1 })).toBeUndefined()
    expect(forkCutOf({ parentSession: PARENT, cutSeq: SessionSeq(3), createdAt: 1 }))
      .toEqual({ parentSession: PARENT, cutSeq: 3 })
    expect(forkCutOf({ parentSession: PARENT, cutSeq: SessionSeq(3), cutTurn: 1, createdAt: 1 }))
      .toEqual({ parentSession: PARENT, cutSeq: 3, cutTurn: 1 })
  })
})

describe('lastInheritedTurn', () => {
  const cut = { parentSession: PARENT, cutSeq: SessionSeq(10) }

  it('falls back to the projected cut Turn when no loaded Turn starts before the cut', () => {
    expect(lastInheritedTurn(timeline(), { ...cut, cutTurn: 2 })).toBe(2)
    expect(lastInheritedTurn(timeline(), cut)).toBeUndefined()
    // A Turn whose start is paged out is known only through the projection.
    expect(lastInheritedTurn(timeline(turn(3)), { ...cut, cutTurn: 2 })).toBe(2)
  })

  it('takes the Turn the cut interrupts and ignores Turns opened after it', () => {
    expect(lastInheritedTurn(timeline(turn(1, 0), turn(2, 6), turn(3, 11)), { ...cut, cutTurn: 1 })).toBe(2)
    expect(lastInheritedTurn(timeline(turn(1, 0)), cut)).toBe(1)
    expect(lastInheritedTurn(timeline(turn(1, 0), turn(2, 6)), { ...cut, cutTurn: 2 })).toBe(2)
  })
})

describe('inheritedEntryCount', () => {
  const nodes = new Map<string, ChatConversationViewNode>([
    ['before', node('before', 1, { kind: 'session' })],
    ['t1', node('t1', 2, { kind: 'turn', turn: turn(1, 2) })],
    ['s1', node('s1', 3, { kind: 'step', turn: turn(1, 2), step: { step: 1 } as never })],
    ['unresolved', node('unresolved', 4, { kind: 'unresolved' })],
    ['after', node('after', 9, { kind: 'session' })],
    ['t2', node('t2', 9, { kind: 'turn', turn: turn(2, 8) })],
  ])
  const groupTurns = new Map<string, number>([['g1', 1], ['g2', 2]])
  const count = (keys: readonly RenderEntry[], inheritedTurn: number | undefined) => inheritedEntryCount(
    keys, key => nodes.get(key), key => groupTurns.get(key), SessionSeq(5), inheritedTurn,
  )
  const n = (key: string): RenderEntry => ({ kind: 'node', key: key as NodeKey })
  const g = (key: string): RenderEntry => ({ kind: 'group', key: key as GroupKey })

  it('counts the leading Session history, inherited Turns, and their groups', () => {
    expect(count([n('before'), n('t1'), g('g1'), n('s1'), n('unresolved'), n('t2'), g('g2')], 1)).toBe(5)
  })

  it('ends the prefix at the first own or unknown entry', () => {
    expect(count([], 1)).toBe(0)
    expect(count([n('after'), n('t2')], 1)).toBe(0)
    expect(count([n('before'), n('missing'), n('t2')], 1)).toBe(1)
    expect(count([n('t1'), g('unknown'), n('t2')], 1)).toBe(1)
    expect(count([g('g1'), g('g2'), n('t2')], 1)).toBe(1)
    // Without an inherited Turn, only Session history before the cut is inherited.
    expect(count([n('before'), n('t1')], undefined)).toBe(1)
    expect(count([n('before'), g('g1')], undefined)).toBe(1)
  })

  it('classifies a logarithmic number of entries', () => {
    const entries = Array.from({ length: 1_024 }, (_, index) => n(index < 700 ? 't1' : 't2'))
    const nodeOf = vi.fn((key: NodeKey) => nodes.get(key))
    expect(inheritedEntryCount(entries, nodeOf, () => undefined, SessionSeq(5), 1)).toBe(700)
    expect(nodeOf.mock.calls.length).toBeLessThanOrEqual(11)
  })

  it('rejects an entry kind outside the closed union', () => {
    expect(() => count([{ kind: 'other' } as never], 1)).toThrow()
  })
})

describe('InheritedSpanRow', () => {
  it.each([
    { locale: 'zh', t: makeTranslate(zh, commonZh), single: '继承自父会话 · 第 1 轮 · 7 步', range: '继承自父会话 · 第 1–3 轮 · 1 步', bare: '继承自父会话 · 第 1 轮' },
    { locale: 'en', t: makeTranslate(en, commonEn), single: 'Inherited from parent · turn 1 · 7 steps', range: 'Inherited from parent · turns 1–3 · 1 step', bare: 'Inherited from parent · turn 1' },
  ])('names the inherited Turns and steps ($locale)', ({ t, single, range, bare }) => {
    const toggle = vi.fn()
    const view = render(<InheritedSpanRow turn={1} steps={7} open={false} onToggle={toggle} t={t} />)
    const button = view.getByRole('button', { name: single })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.hasAttribute('data-open')).toBe(false)
    fireEvent.click(button)
    expect(toggle).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(button)
    view.rerender(<InheritedSpanRow turn={3} steps={1} open onToggle={toggle} t={t} />)
    expect(view.getByRole('button', { name: range }).getAttribute('aria-expanded')).toBe('true')
    view.rerender(<InheritedSpanRow turn={1} steps={undefined} open={false} onToggle={toggle} t={t} />)
    expect(view.getByRole('button', { name: bare })).toBeTruthy()
  })
})
