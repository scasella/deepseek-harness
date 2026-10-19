// @vitest-environment jsdom
/** The Loom tab reads a fork family as an APG tree beside the selected Session's path document. */
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { KeyedSnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { LoomRequestView } from '@deepseek-ai/dsh-experimental-loom/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LoomSetId } from '@deepseek-ai/dsh-experimental-loom/types'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionStatsFigures } from '@deepseek-ai/dsh-session-stats/client'
import type {} from '@deepseek-ai/dsh-session-turn-outline/client'
import type { LoomBranchingState } from '../src/client/branching.ts'
import { createLoomFamilySources, type LoomFamilyState } from '../src/client/family.ts'
import { en, zh } from '../src/client/locales.ts'
import { LoomView, type LoomViewProps } from '../src/client/LoomView.tsx'
import type { LoomReaderState, LoomReaderTurn } from '../src/client/reader.ts'
import type { LoomRequestState } from '../src/client/requests.ts'
import { createLoomViewStore } from '../src/client/view-store.ts'

afterEach(() => { cleanup() })

const ROOT = SessionId('root')
const A = SessionId('a')
const B = SessionId('b')
const C = SessionId('c')

function figures(turns: number, steps: number): SessionStatsFigures {
  return { turns, steps, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }
}

function usage(total: number) {
  return { uncachedInputTokens: total, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
}

const OUTLINE = [
  { turn: 1, seq: SessionSeq(0), prompt: 'Find the cause of the failing test.', response: 'Sections: cause, options.' },
  { turn: 2, seq: SessionSeq(15), prompt: 'Go with C.', response: 'Done.' },
]

function row(id: SessionId, title: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, displayTitle: title, running: false, blank: false, updatedAt: 1, retainedBy: {}, ...extra }
}

function fork(id: SessionId, title: string, cutSeq: number, createdAt: number, cutTurn?: number): SessionSummary {
  return row(id, title, {
    parentId: ROOT,
    projectionValues: {
      forkLineage: { parentSession: ROOT, cutSeq: SessionSeq(cutSeq), createdAt, ...cutTurn === undefined ? {} : { cutTurn } },
      sessionStats: { ...figures(2, 11), fork: { own: figures(1, 4), inherited: figures(1, 7) } },
      tokenUsage: { ...usage(2000), fork: { own: usage(1500), inherited: usage(500) } },
      turnOutline: OUTLINE,
    },
  })
}

function listOf(rows: readonly SessionSummary[]): SessionListState {
  return { ids: rows.map(item => item.id), byId: Object.fromEntries(rows.map(item => [item.id, item])), phase: 'ready', projectionsBySession: {} }
}

const ROWS = [
  row(ROOT, 'Failing delay test', { projectionValues: { sessionStats: figures(1, 7), tokenUsage: usage(500), turnOutline: OUTLINE } }),
  fork(A, 'Clamp final value', 10, 1, 1),
  fork(B, 'Downward-only jitter', 10, 2, 1),
  fork(C, 'Later cut', 20, 3),
]

const OWN_TURN: LoomReaderTurn = {
  turn: 2, startSeq: 15, prompt: 'Go with C.', reply: '**Done.** Option C is in.', capturedReply: [{ text: 'Done.', logprobs: { tokens: ['Done.'], logprobs: [-1], top: [[]] } }], reasoning: 'Weigh the options.',
  reasoningTokens: 1234, usage: { inputTokens: 24_432, cachedTokens: 151_808, outputTokens: 4_629 }, closingSeq: 40, closed: true,
}
const { startSeq: _ownStart, ...UNSTARTED_OWN } = OWN_TURN
/** An own turn whose `turn/start` lies before the loaded window. */
const UNSTARTED_TURN: LoomReaderTurn = { ...UNSTARTED_OWN, turn: 3 }
const INHERITED_TURN: LoomReaderTurn = { turn: 1, startSeq: 0, prompt: 'Find the cause.', reply: 'Sections.', reasoning: '', closed: true }

const VIEW: LoomRequestView = {
  route: { provider: 'openrouter', model: 'deepseek-v4.1', reasoningEffort: 'high' },
  systemPrompt: { chars: 5671, text: 'system', changedAtTurn: 2 },
  tools: { names: ['read', 'write', 'present'], addedThisTurn: ['present'], removedThisTurn: ['bash'] },
  messages: [
    { seq: SessionSeq(1), role: 'user', inherited: true, preview: 'Find', chars: 4 },
    { seq: SessionSeq(16), role: 'user', inherited: false, preview: 'Go', chars: 2 },
  ],
  inheritedTurns: 1,
  ownTurns: 1,
}

/** Keyed observable sources the test drives, bound the way the renderer binds `keyedHooks`. */
class KeyedStates<T> {
  readonly stores = new Map<string, SnapshotStore<T | undefined>>()
  readonly hook: KeyedSnapshotSelectorHook<T>
  constructor(private readonly initial: (key: string) => T | undefined) {
    this.hook = ((key: string, select?: (value: T | undefined) => unknown, equal?: (left: unknown, right: unknown) => boolean): unknown =>
      bindSnapshotSelector(this.store(key))(value => select === undefined ? value : select(value), equal)) as KeyedSnapshotSelectorHook<T>
  }
  store(key: string): SnapshotStore<T | undefined> {
    let store = this.stores.get(key)
    if (store === undefined) {
      store = createSnapshotStore(this.initial(key))
      this.stores.set(key, store)
    }
    return store
  }
}

function keyed<T>(source: (key: string) => ObservableSnapshot<T>): KeyedSnapshotSelectorHook<T> {
  return ((key: string, select?: (value: T | undefined) => unknown, equal?: (left: unknown, right: unknown) => boolean): unknown =>
    bindSnapshotSelector(source(key))(value => select === undefined ? value : select(value), equal)) as KeyedSnapshotSelectorHook<T>
}

function bench(options: {
  rows?: readonly SessionSummary[]
  sessionId?: SessionId
  viewRequest?: { view: string; focus: string }
  locale?: 'en' | 'zh'
  reader?: (key: string) => LoomReaderState | undefined
  request?: (key: string) => LoomRequestState | undefined
  phase?: SessionListState['phase']
  branching?: LoomBranchingState
} = {}) {
  const branching = createSnapshotStore<LoomBranchingState>(options.branching ?? { sets: [], forms: {}, marks: {} })
  const sessions = createSnapshotStore<SessionListState>({ ...listOf(options.rows ?? ROWS), phase: options.phase ?? 'ready' })
  const statuses = createSnapshotStore<SessionStatusSnapshot>(new Map())
  const families = createLoomFamilySources({ sessions })
  const readers = new KeyedStates<LoomReaderState>(options.reader ?? (key => ({
    status: 'ready',
    document: { hasMore: false, turns: key === B ? [INHERITED_TURN, OWN_TURN] : [INHERITED_TURN] },
  })))
  const requests = new KeyedStates<LoomRequestState>(options.request ?? (() => ({ status: 'ready', view: VIEW })))
  const store = createLoomViewStore().create()
  const injected = {
    openSession: vi.fn(),
    refreshProjection: vi.fn(),
    loadOlder: vi.fn(),
    completeViewRequest: vi.fn(),
    insetComposerStart: vi.fn(),
    openForm: vi.fn(),
    setMark: vi.fn(async () => ({ ok: true as const })),
    renderFactorySlot: vi.fn((_name: string, props: { text: string }): ReactNode => <div data-testid="reasoning-body">{props.text}</div>),
  }
  const props = {
    sessionId: options.sessionId ?? B,
    inspectCall: undefined,
    viewRequest: options.viewRequest ?? null,
    openView: vi.fn(),
    useSessions: bindSnapshotSelector(sessions),
    useSessionStatus: bindSnapshotSelector(statuses),
    useLoomFamily: keyed<LoomFamilyState>(key => families.source(key)),
    useLoomReader: readers.hook,
    useLoomRequest: requests.hook,
    useLoomWeave: () => ({ status: 'loading' }),
    useProjection: (_name: string, select: (value: undefined) => unknown) => select(undefined),
    useLoomRoutes: (select: (value: { status: 'unavailable' }) => unknown) => select({ status: 'unavailable' }),
    useStore: bindSnapshotSelector(store),
    useLoomBranching: bindSnapshotSelector(branching),
    actions: store.actions,
    t: options.locale === 'zh' ? makeTranslate(zh, commonZh) : makeTranslate(en, commonEn),
    ...injected,
  } as LoomViewProps
  const view = render(<LoomView {...props} />)
  return { view, store, sessions, statuses, readers, requests, injected, branching }
}

function treeRows(): HTMLElement[] {
  return within(screen.getByRole('tree', { name: 'Fork family' })).getAllByRole('treeitem')
}

function names(): (string | null)[] {
  return treeRows().map(item => item.getAttribute('aria-label'))
}

describe('Loom tab tree', () => {
  it('switches to prose mode without requiring a fork family', () => {
    bench()
    fireEvent.click(screen.getByRole('tab', { name: 'Weave' }))
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Loading prose')
  })

  it('outlines the family with branch points, APG positions, the current Session, and own figures', () => {
    bench()
    expect(screen.getByText('Family · 4 sessions · own token usage')).toBeTruthy()
    expect(names()).toEqual([
      'Failing delay test, 1 turn · 7 steps, own 500 tok, ended',
      'After turn 1, 2 branches, 3K tok total',
      'Clamp final value, 1 turn · 4 steps, own 1.5K tok, ended',
      'Downward-only jitter, 1 turn · 4 steps, own 1.5K tok, ended',
      'During turn 2, 1 branch, 1.5K tok total',
      'Later cut, 1 turn · 4 steps, own 1.5K tok, ended',
    ])
    const [root, point, a, b] = treeRows() as [HTMLElement, HTMLElement, HTMLElement, HTMLElement]
    expect(root.getAttribute('aria-level')).toBe('1')
    expect(root.getAttribute('aria-expanded')).toBe('true')
    expect(point.getAttribute('aria-level')).toBe('2')
    expect(point.getAttribute('aria-setsize')).toBe('2')
    expect(a.getAttribute('aria-posinset')).toBe('1')
    expect(a.getAttribute('aria-expanded')).toBeNull()
    expect(b.getAttribute('aria-selected')).toBe('true')
    expect(b.getAttribute('aria-current')).toBe('true')
    expect(a.getAttribute('aria-selected')).toBe('false')
    expect(point.getAttribute('aria-selected')).toBeNull()
    expect(treeRows().filter(item => item.tabIndex === 0)).toEqual([b])
  })

  it('moves focus, collapses, expands, and reads with the APG keys while a row has focus', () => {
    const { store } = bench()
    const rows = (): HTMLElement[] => treeRows()
    const at = (index: number): HTMLElement => rows()[index]!
    act(() => { at(3).focus() })
    fireEvent.keyDown(at(3), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(at(4))
    fireEvent.keyDown(at(4), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(at(3))
    fireEvent.keyDown(at(3), { key: 'Home' })
    expect(document.activeElement).toBe(at(0))
    fireEvent.keyDown(at(0), { key: 'End' })
    expect(document.activeElement).toBe(at(5))
    fireEvent.keyDown(at(5), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(at(5))
    fireEvent.keyDown(at(5), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(at(5))
    fireEvent.keyDown(at(5), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(at(4))
    fireEvent.keyDown(at(4), { key: 'ArrowLeft' })
    expect(rows()).toHaveLength(5)
    expect(at(4).getAttribute('aria-expanded')).toBe('false')
    fireEvent.keyDown(at(4), { key: 'ArrowRight' })
    expect(rows()).toHaveLength(6)
    fireEvent.keyDown(at(4), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(at(5))
    fireEvent.keyDown(at(5), { key: 'Enter' })
    expect(store.getSnapshot().selected).toBe(C)
    fireEvent.keyDown(at(4), { key: ' ' })
    expect(rows()).toHaveLength(5)
    act(() => { at(0).focus() })
    fireEvent.keyDown(at(0), { key: 'ArrowLeft' })
    expect(rows()).toHaveLength(1)
    fireEvent.keyDown(at(0), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(at(0))
    expect(fireEvent.keyDown(at(0), { key: 'ArrowRight', ctrlKey: true })).toBe(true)
    expect(rows()).toHaveLength(1)
    expect(fireEvent.keyDown(at(0), { key: 'q' })).toBe(true)
    expect(fireEvent.keyDown(at(0), { key: 'ArrowUp' })).toBe(false)
    expect(document.activeElement).toBe(at(0))
  })

  it('selects a Session or toggles a branch point on click, and toggles from the chevron without selecting', () => {
    const { store } = bench()
    const chevron = (row: HTMLElement): HTMLElement => row.querySelector<HTMLElement>('[data-loom-disclosure]')!
    fireEvent.click(treeRows()[2]!)
    expect(store.getSnapshot()).toMatchObject({ selected: A, active: 's:a' })
    // The chevron is a pointer target only: it exposes no control and leaves focus and the tab stop on its row.
    expect(within(screen.getByRole('tree')).queryAllByRole('button')).toEqual([])
    expect(chevron(treeRows()[1]!).getAttribute('aria-hidden')).toBe('true')
    fireEvent.click(chevron(treeRows()[1]!))
    expect(store.getSnapshot()).toMatchObject({ selected: A, collapsed: ['p:root:10'], active: 'p:root:10' })
    expect(names()).toHaveLength(4)
    expect(document.activeElement).toBe(treeRows()[1])
    expect(treeRows().filter(item => item.tabIndex === 0)).toEqual([treeRows()[1]])
    fireEvent.click(treeRows()[1]!)
    expect(names()).toHaveLength(6)
    fireEvent.click(chevron(treeRows()[0]!))
    expect(names()).toHaveLength(1)
    expect(store.getSnapshot().selected).toBe(A)
    expect(document.activeElement).toBe(treeRows()[0])
  })

  it('draws a guide for each continuing level and an elbow to each child', () => {
    bench()
    const guides = (index: number): string[] => [...treeRows()[index]!.querySelectorAll<HTMLElement>('span[style*="left"]')]
      .map(guide => `${guide.className.includes('stem') ? 'stem' : guide.className.includes('Through') ? 'through' : guide.className.includes('elbow') ? 'elbow' : 'rail'}@${guide.style.left}`)
    expect(guides(0)).toEqual(['stem@15px'])
    expect(guides(1)).toEqual(['through@-4px', 'stem@15px'])
    expect(guides(2)).toEqual(['rail@-23px', 'through@-4px'])
    expect(guides(3)).toEqual(['rail@-23px', 'elbow@-4px'])
    expect(guides(4)).toEqual(['elbow@-4px', 'stem@15px'])
    expect(guides(5)).toEqual(['elbow@-4px'])
    expect(treeRows().map(item => item.style.marginLeft)).toEqual(['0px', '19px', '38px', '38px', '19px', '38px'])
  })

  it('keeps the composer under the reading pane while the panes sit side by side', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const left = this.getAttribute('aria-label') === 'Selected path' ? 340 : 0
      return { left, right: left + 100, top: 0, bottom: 0, width: 100, height: 0, x: left, y: 0, toJSON: () => ({}) }
    })
    try {
      const { injected, view } = bench()
      expect(injected.insetComposerStart).toHaveBeenLastCalledWith(340)
      view.unmount()
      expect(injected.insetComposerStart).toHaveBeenLastCalledWith(0)
    } finally { rect.mockRestore() }
    bench()
    expect(screen.getByRole('tree', { name: 'Fork family' }).closest('section')?.getAttribute('aria-label')).toBeNull()
  })

  it('asks once for each member missing figures or lineage', () => {
    const bare = [row(ROOT, 'Root'), row(A, 'Untitled', { parentId: ROOT, blank: true })]
    const { injected, sessions } = bench({ rows: bare, sessionId: A })
    expect(injected.refreshProjection.mock.calls).toEqual([[ROOT], [A]])
    act(() => { sessions.set({ ...listOf(bare) }) })
    expect(injected.refreshProjection).toHaveBeenCalledTimes(2)
    expect(names()).toEqual(['Root, ended', 'Branch point, 1 branch', 'Untitled, no turns yet'])
  })

  it('reports a loading or unlisted family', () => {
    bench({ phase: 'pending' })
    expect(screen.getByRole('status').textContent).toBe('Loading fork family…')
    cleanup()
    bench({ sessionId: SessionId('gone') })
    expect(screen.getByText('Fork family is unavailable')).toBeTruthy()
    expect(screen.queryByRole('tree')).toBeNull()
  })

  it('reads the family member a view request names and acknowledges every request addressed to the tab', () => {
    const member = bench({ viewRequest: { view: 'loom', focus: A } })
    expect(member.store.getSnapshot().selected).toBe(A)
    expect(member.injected.completeViewRequest).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { name: 'Clamp final value' })).toBeTruthy()
    cleanup()
    const stranger = bench({ viewRequest: { view: 'loom', focus: 'elsewhere' } })
    expect(stranger.store.getSnapshot().selected).toBeNull()
    expect(stranger.injected.completeViewRequest).toHaveBeenCalledOnce()
    cleanup()
    const unlisted = bench({ sessionId: SessionId('gone'), viewRequest: { view: 'loom', focus: A } })
    expect(unlisted.injected.completeViewRequest).toHaveBeenCalledOnce()
    cleanup()
    const pending = bench({ phase: 'pending', viewRequest: { view: 'loom', focus: A } })
    expect(pending.injected.completeViewRequest).not.toHaveBeenCalled()
    act(() => { pending.sessions.set(listOf(ROWS)) })
    expect(pending.injected.completeViewRequest).toHaveBeenCalledOnce()
    expect(pending.store.getSnapshot().selected).toBe(A)
    cleanup()
    const other = bench({ viewRequest: { view: 'trajectory', focus: 'call-1' } })
    expect(other.injected.completeViewRequest).not.toHaveBeenCalled()
  })

  it('opens the Branch ×N form for the focused node with g, and toggles marks with k and x', () => {
    const rows = ROWS.map(item => item.id === B
      ? { ...item, projectionValues: { ...item.projectionValues, loomMark: { mark: 'keep' as const } } }
      : item.id === C ? { ...item, projectionValues: { ...item.projectionValues, turnOutline: [] } } : item)
    const { injected, statuses } = bench({ rows })
    act(() => { statuses.set(new Map([[A, { running: true, pendingInteraction: undefined, completionUnread: false }]])) })
    const at = (index: number): HTMLElement => treeRows()[index]!
    expect(names()[3]).toBe('Downward-only jitter, 1 turn · 4 steps, own 1.5K tok, ended, kept')
    expect(at(3).querySelector('svg')).toBeTruthy()
    expect(names()[1]).toBe('After turn 1, 2 branches, 3K tok total, 1 running')
    expect(at(1).textContent).toContain('1 running')
    fireEvent.keyDown(at(0), { key: 'g' })
    expect(injected.openForm).toHaveBeenLastCalledWith(B, { sourceSessionId: ROOT, afterTurn: 2 })
    fireEvent.keyDown(at(1), { key: 'g' })
    expect(injected.openForm).toHaveBeenLastCalledWith(B, { sourceSessionId: ROOT, afterTurn: 1 })
    fireEvent.keyDown(at(2), { key: 'g' })
    expect(injected.openForm).toHaveBeenLastCalledWith(B, { sourceSessionId: A, afterTurn: 1 })
    fireEvent.keyDown(at(4), { key: 'g' })
    fireEvent.keyDown(at(5), { key: 'g' })
    expect(injected.openForm).toHaveBeenCalledTimes(3)
    fireEvent.keyDown(at(3), { key: 'k' })
    expect(injected.setMark).toHaveBeenLastCalledWith(B, null)
    fireEvent.keyDown(at(3), { key: 'x' })
    expect(injected.setMark).toHaveBeenLastCalledWith(B, 'set-aside')
    fireEvent.keyDown(at(2), { key: 'k' })
    expect(injected.setMark).toHaveBeenLastCalledWith(A, 'keep')
    fireEvent.keyDown(at(1), { key: 'x' })
    expect(injected.setMark).toHaveBeenCalledTimes(3)
    expect(screen.getByText('branch')).toBeTruthy()
    cleanup()
    // Before the parent's outline arrives, a point with an ended cut turn is still branchable after that turn.
    const bare = bench({ rows: [row(ROOT, 'Failing delay test'), ...ROWS.slice(1)] })
    fireEvent.keyDown(treeRows()[1]!, { key: 'g' })
    expect(bare.injected.openForm).toHaveBeenCalledWith(B, { sourceSessionId: ROOT, afterTurn: 1 })
  })

  it('shows a mark this browser saves, and reports a failed save under the tree', () => {
    const { branching } = bench()
    act(() => { branching.set({ sets: [], forms: {}, marks: { [A]: { status: 'saving', mark: 'set-aside' } } }) })
    expect(treeRows()[2]!.getAttribute('aria-label')).toContain(', set aside')
    act(() => { branching.set({ sets: [], forms: {}, marks: { [A]: { status: 'failed', failure: { code: 'session/not-found', unknownOutcome: false } } } }) })
    expect(screen.getByRole('status').textContent).toBe('This Session was not found')
  })

  it('tallies the prompt variants of a variants set under the tree', () => {
    const variant = (id: SessionId, index: number, key: string, createdAt: number, mark?: 'keep' | 'set-aside') => {
      const base = fork(id, `variant ${id}`, 10, createdAt, 1)
      return {
        ...base,
        projectionValues: {
          ...base.projectionValues,
          loomBranch: { setId: brandString<LoomSetId>('set-v'), kind: 'variants' as const, index, variantKey: key, createdAt },
          turnOutline: [...OUTLINE.slice(0, 1), { turn: 2, seq: SessionSeq(15), prompt: `**Line** ${key}`, response: '' }],
          ...mark === undefined ? {} : { loomMark: { mark } },
        },
      }
    }
    bench({ rows: [ROWS[0]!, variant(A, 0, 'one', 1, 'keep'), variant(B, 1, 'one', 2), variant(C, 2, 'two', 3, 'set-aside')] })
    const tallies = screen.getByRole('region', { name: 'Prompt variants' })
    expect(tallies.textContent).toContain('Prompt variants after turn 1')
    expect([...tallies.querySelectorAll('li')].map(item => item.textContent)).toEqual([
      '1Line one2 samples · 1 kept · 0 set aside',
      '2Line two1 sample · 0 kept · 1 set aside',
    ])
    cleanup()
    const unloaded = variant(A, 0, 'one', 1)
    const firstOnly = { ...unloaded, projectionValues: { ...unloaded.projectionValues, turnOutline: OUTLINE.slice(0, 1) } }
    bench({ sessionId: A, rows: [ROWS[0]!, firstOnly] })
    expect(screen.getByRole('region', { name: 'Prompt variants' }).textContent).toContain('Prompt not loaded yet')
    cleanup()
    bench()
    expect(screen.queryByRole('region', { name: 'Prompt variants' })).toBeNull()
  })

  it('marks a running Session from live status', () => {
    const { statuses } = bench()
    act(() => { statuses.set(new Map([[A, { running: true, pendingInteraction: undefined, completionUnread: false }]])) })
    expect(names()[2]).toBe('Clamp final value, 1 turn · 4 steps, own 1.5K tok, running')
  })
})

describe('Loom reading pane', () => {
  it('reads the current fork as one document: inherited preview, cut, and own turns', () => {
    const { injected } = bench()
    const pane = screen.getByRole('region', { name: 'Selected path' })
    expect(within(pane).getByRole('heading', { name: 'Downward-only jitter' })).toBeTruthy()
    expect(within(pane).queryByRole('button', { name: /Open in Chat/u })).toBeNull()
    const inherited = within(pane).getByRole('button', { name: 'Inherited from parent · turn 1 · 7 steps' })
    expect(inherited.getAttribute('aria-expanded')).toBe('false')
    expect(within(pane).getByText('Find the cause of the failing test.')).toBeTruthy()
    expect(within(pane).getByText('Sections: cause, options.')).toBeTruthy()
    fireEvent.click(inherited)
    expect(within(pane).getByText('Turn 1')).toBeTruthy()
    expect(pane.textContent).toContain('Branched from Failing delay test after turn 1 · Variant 2 of 2')
    const turn = within(pane).getByRole('region', { name: 'Turn 2' })
    expect(within(turn).getByText('Go with C.')).toBeTruthy()
    expect(within(turn).getByText('Done.', { selector: 'strong' }).tagName).toBe('STRONG')
    expect(within(turn).queryByRole('region', { name: 'Turn 1' })).toBeNull()
    expect(turn.textContent).toContain('1234 tokens this turn')
    expect(injected.renderFactorySlot).not.toHaveBeenCalled()
    fireEvent.click(within(turn).getByText('Reasoning'))
    expect(injected.renderFactorySlot).toHaveBeenCalledWith('conversation.chat.reasoning.content', { text: 'Weigh the options.', running: false })
    expect(within(turn).getByTestId('reasoning-body').textContent).toBe('Weigh the options.')
  })

  it('shows what the model saw for a turn once opened', () => {
    const { requests, readers } = bench()
    const readerStore = readers.store(B)
    const toggle = screen.getByRole('button', { name: 'What the model saw for this turn' })
    expect(requests.stores.size).toBe(0)
    fireEvent.click(toggle)
    expect([...requests.stores.keys()]).toEqual(['b:40'])
    const chips = screen.getAllByRole('listitem').map(item => item.textContent)
    expect(chips).toEqual([
      'System prompt5,671 characters · rebuilt for turn 2',
      '3 tools · 1 added this turn · 1 removed this turn',
      'Inherited1 turn · 7 steps',
      'Own1 turn · 4 steps',
    ])
    expect(screen.getByText('Own turn usage: 24,432 new input · 151,808 cached · 4,629 output tokens')).toBeTruthy()
    expect(screen.getByText('2 messages, 1 inherited').parentElement?.textContent)
      .toBe('2 messages, 1 inherited · Route openrouter · deepseek-v4.1 · high')
    act(() => {
      requests.store('b:40').set({ status: 'ready', view: {
        ...VIEW,
        route: { provider: 'deepseek', model: 'v4' },
        systemPrompt: { chars: 1, text: 'x' },
        tools: { names: ['read'], addedThisTurn: [], removedThisTurn: [] },
        messages: [VIEW.messages[0]!],
        inheritedTurns: 2,
        ownTurns: 1,
      } })
    })
    // Session figures that cover other turns than the request saw add no steps.
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'System prompt1 characters', '1 tool', 'Inherited2 turns', 'Own1 turn · 4 steps',
    ])
    expect(screen.getByText('1 message, 1 inherited')).toBeTruthy()
    expect(screen.getByText('Route deepseek · v4')).toBeTruthy()
    // A turn whose provider did not report cached input reads only new input and output.
    act(() => {
      readerStore.set({ status: 'ready', document: { hasMore: false, turns: [INHERITED_TURN, { ...OWN_TURN, usage: { inputTokens: 10, outputTokens: 2 } }] } })
    })
    expect(screen.getByText('Own turn usage: 10 new input · 2 output tokens')).toBeTruthy()
    fireEvent.click(toggle)
    expect(screen.queryAllByRole('listitem')).toEqual([])
  })

  it('reports each request read state', () => {
    const { requests } = bench({ request: () => ({ status: 'loading' }) })
    fireEvent.click(screen.getByRole('button', { name: 'What the model saw for this turn' }))
    expect(screen.getByText('Reading the request…')).toBeTruthy()
    const store = requests.store('b:40')
    const lines: [LoomRequestState, string][] = [
      [{ status: 'failed' }, 'The request cannot be read right now'],
      [{ status: 'failed', code: 'session/not-found' }, 'This Session was not found'],
      [{ status: 'failed', code: 'loom/seq-out-of-range' }, 'No model request settled before this point'],
      [{ status: 'failed', code: 'remote-access/denied' }, 'You cannot read this Session'],
      [{ status: 'failed', code: 'remote/timeout' }, 'The request could not be read (remote/timeout)'],
    ]
    for (const [state, line] of lines) {
      act(() => { store.set(state) })
      expect(screen.getByRole('alert').textContent).toBe(line)
    }
    act(() => { store.set(undefined) })
    expect(screen.getByText('Reading the request…')).toBeTruthy()
  })

  it('reads another family member chosen in the tree and opens it in Chat', () => {
    const { injected } = bench()
    fireEvent.click(treeRows()[0]!)
    const pane = screen.getByRole('region', { name: 'Selected path' })
    expect(within(pane).getByRole('heading', { name: 'Failing delay test' })).toBeTruthy()
    expect(within(pane).queryByRole('button', { name: /Inherited/u })).toBeNull()
    expect(within(pane).getByRole('region', { name: 'Turn 1' })).toBeTruthy()
    fireEvent.click(within(pane).getByRole('button', { name: 'Open in Chat: Failing delay test' }))
    expect(injected.openSession).toHaveBeenCalledWith(ROOT)
  })

  it('reads a lone variant cut inside a turn without a variant number', () => {
    bench({
      sessionId: C,
      reader: () => ({ status: 'ready', document: { hasMore: false, turns: [UNSTARTED_TURN] } }),
    })
    const pane = screen.getByRole('region', { name: 'Selected path' })
    expect(pane.textContent).toContain('Branched from Failing delay test during turn 2')
    expect(pane.textContent).not.toContain('Variant')
    expect(within(pane).getByRole('button', { name: 'Inherited from parent · 2 turns · 7 steps' })).toBeTruthy()
    expect(within(pane).getByRole('region', { name: 'Turn 3' })).toBeTruthy()
  })

  it('falls back to the cut turn and omits counts it does not have', () => {
    const rows = [row(ROOT, 'Root'), row(A, 'Child', {
      parentId: ROOT,
      projectionValues: { forkLineage: { parentSession: ROOT, cutSeq: SessionSeq(5), cutTurn: 3, createdAt: 1 } },
    })]
    bench({ rows, sessionId: A })
    const pane = screen.getByRole('region', { name: 'Selected path' })
    expect(within(pane).getByRole('button', { name: 'Inherited from parent · turn 3' })).toBeTruthy()
    expect(names()[1]).toBe('After turn 3, 1 branch')
    cleanup()
    bench({ rows: [row(ROOT, 'Root'), row(A, 'Child', {
      parentId: ROOT,
      projectionValues: { forkLineage: { parentSession: ROOT, cutSeq: SessionSeq(5), createdAt: 1 } },
    })], sessionId: A })
    expect(names()[1]).toBe('Before turn 1 ended, 1 branch')
    cleanup()
    bench({ rows: [row(A, 'Orphan', { parentId: ROOT, projectionValues: { forkLineage: { parentSession: ROOT, cutSeq: SessionSeq(5), createdAt: 1 } } })], sessionId: A })
    const orphan = screen.getByRole('region', { name: 'Selected path' })
    expect(within(orphan).getByRole('button', { name: 'Inherited from parent' })).toBeTruthy()
    expect(orphan.textContent).toContain('Branched before turn 1 ended')
  })

  it('reports reader states, pages in earlier turns, and names turns without a reply', () => {
    const { readers, injected } = bench({ reader: () => undefined })
    const pane = screen.getByRole('region', { name: 'Selected path' })
    expect(within(pane).getByRole('status').textContent).toBe('Reading the Session…')
    const store = readers.store(B)
    act(() => { store.set({ status: 'loading' }) })
    expect(within(pane).getByRole('status').textContent).toBe('Reading the Session…')
    act(() => { store.set({ status: 'failed' }) })
    expect(within(pane).getByRole('alert').textContent).toBe('This Session could not be read')
    act(() => { store.set({ status: 'ready', document: { hasMore: true, turns: [] } }) })
    fireEvent.click(within(pane).getByRole('button', { name: 'Load earlier turns' }))
    expect(injected.loadOlder).toHaveBeenCalledWith(B)
    act(() => { store.set({ status: 'ready', document: { hasMore: true, turns: [{ ...OWN_TURN, turn: 3, startSeq: 50 }] } }) })
    expect(pane.textContent).toContain('Earlier turns are not loaded')
    act(() => { store.set({ status: 'ready', document: { hasMore: true, turns: [OWN_TURN] } }) })
    expect(pane.textContent).not.toContain('Earlier turns are not loaded')
    act(() => { store.set({ status: 'ready', document: { hasMore: false, turns: [INHERITED_TURN] } }) })
    expect(pane.textContent).toContain('This Session has no turns of its own yet')
    act(() => {
      store.set({ status: 'ready', document: { hasMore: false, turns: [
        { turn: 2, prompt: '', reply: '', reasoning: '', closed: false },
        { turn: 3, startSeq: 60, prompt: 'q', reply: '', reasoning: 'r', closed: true },
      ] } })
    })
    expect(pane.textContent).toContain('This turn is still running')
    expect(pane.textContent).toContain('This turn has no reply text')
    expect(within(pane).queryByRole('button', { name: 'What the model saw for this turn' })).toBeNull()
    expect(within(pane).getByText('Reasoning')).toBeTruthy()
    expect(pane.textContent).not.toContain('tokens this turn')
  })

  it('splits a subagent child at its lineage like Chat, without a cut line', () => {
    const subagent = row(A, 'Researcher', {
      parentId: ROOT,
      origin: 'subagent',
      projectionValues: {
        forkLineage: { parentSession: ROOT, cutSeq: SessionSeq(10), cutTurn: 1, createdAt: 1 },
        sessionStats: { ...figures(2, 11), fork: { own: figures(1, 4), inherited: figures(1, 7) } },
        turnOutline: OUTLINE,
      },
    })
    bench({
      rows: [ROWS[0]!, subagent],
      sessionId: A,
      reader: () => ({ status: 'ready', document: { hasMore: false, turns: [INHERITED_TURN, OWN_TURN] } }),
    })
    const pane = screen.getByRole('region', { name: 'Selected path' })
    expect(within(pane).getByRole('button', { name: 'Inherited from parent · turn 1 · 7 steps' })).toBeTruthy()
    expect(pane.textContent).not.toContain('Branched')
    expect(within(pane).queryByRole('region', { name: 'Turn 1' })).toBeNull()
    expect(within(pane).getByRole('region', { name: 'Turn 2' })).toBeTruthy()
  })

  it('previews inherited Markdown as plain text and shows a clipped preview in full on hover', () => {
    vi.useFakeTimers()
    const width = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(500)
    try {
      const outline = [{ turn: 1, seq: SessionSeq(0), prompt: 'Fix `retry_delay`', response: '## Cause\nThe *base* delay is [capped](x).' }]
      const child = row(A, 'Child', {
        parentId: ROOT,
        projectionValues: { forkLineage: { parentSession: ROOT, cutSeq: SessionSeq(10), cutTurn: 1, createdAt: 1 }, turnOutline: outline },
      })
      bench({ rows: [ROWS[0]!, child], sessionId: A })
      const pane = screen.getByRole('region', { name: 'Selected path' })
      const agent = within(pane).getByText('Cause The base delay is capped.')
      expect(within(pane).getByText('Fix retry_delay')).toBeTruthy()
      fireEvent.mouseEnter(agent)
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getAllByText('Cause The base delay is capped.')).toHaveLength(2)
    } finally {
      width.mockRestore()
      vi.useRealTimers()
    }
  })

  it('renders the tab in Chinese', () => {
    bench({ locale: 'zh' })
    expect(screen.getByRole('tree', { name: 'fork 家族' })).toBeTruthy()
    expect(screen.getByText('家族 · 4 个会话 · 各会话自身的 token 用量')).toBeTruthy()
    expect(screen.getByRole('button', { name: '继承自父会话 · 第 1 轮 · 7 步' })).toBeTruthy()
    expect(screen.getByText('本轮 1234 个 token')).toBeTruthy()
    const rows = within(screen.getByRole('tree', { name: 'fork 家族' })).getAllByRole('treeitem')
    expect(rows[2]?.getAttribute('aria-label')).toBe('Clamp final value，1 轮 · 4 步，自身 1.5K tok，已结束')
  })
})
