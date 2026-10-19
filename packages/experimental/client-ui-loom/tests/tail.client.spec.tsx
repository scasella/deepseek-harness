// @vitest-environment jsdom
/** Loom actions after Branch on a completed Turn: the Branch ×N caret, the variant pager, Regenerate, and the private marks. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { KeyedSnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { LoomMarkView } from '@deepseek-ai/dsh-experimental-loom/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { BranchCaret } from '../src/client/BranchCaret.tsx'
import { CountChoice } from '../src/client/CountChoice.tsx'
import type { LoomBranchingState, LoomOutcome } from '../src/client/branching.ts'
import { createLoomFamilySources, type LoomFamilyState } from '../src/client/family.ts'
import { MarkGroup } from '../src/client/MarkGroup.tsx'
import { RegenerateSplit } from '../src/client/RegenerateSplit.tsx'
import type { LoomReadState } from '../src/client/read-sources.ts'
import type { LoomRoutesState } from '../src/client/routes.ts'
import type { LoomEstimateValue } from '@deepseek-ai/dsh-experimental-loom/types'
import type { LoomTailProps } from '../src/client/tail.ts'
import { VariantPager, VariantPagerBody } from '../src/client/VariantPager.tsx'
import { entry, listOf, ROOT, tEn, tZh, type Member } from './fixtures.client.ts'

const A = SessionId('a')
const B = SessionId('b')
const C = SessionId('c')

/** Report the hover capability a test chooses, with a change listener the test can fire. */
function stubHover(matches: boolean): { change: (next: boolean) => void } {
  const listeners = new Set<() => void>()
  const media = {
    matches,
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener) },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener) },
  }
  vi.stubGlobal('matchMedia', vi.fn(() => media))
  return {
    change: (next) => {
      media.matches = next
      for (const listener of listeners) listener()
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const OUTLINE = [entry(1, 0, 'Find the cause'), entry(2, 15, 'Go with C')]
const MEMBERS: Member[] = [
  { id: 'root', outline: OUTLINE },
  { id: 'a', parent: 'root', cutSeq: 10, cutTurn: 1, createdAt: 1, outline: OUTLINE },
  { id: 'b', parent: 'root', cutSeq: 10, cutTurn: 1, createdAt: 2, outline: OUTLINE },
  { id: 'c', parent: 'root', cutSeq: 10, cutTurn: 1, createdAt: 3, outline: OUTLINE },
]

function keyed<T>(source: (key: string) => ObservableSnapshot<T>): KeyedSnapshotSelectorHook<T> {
  return ((key: string, select?: (value: T | undefined) => unknown, equal?: (left: unknown, right: unknown) => boolean): unknown =>
    bindSnapshotSelector(source(key))(value => select === undefined ? value : select(value), equal)) as KeyedSnapshotSelectorHook<T>
}

interface TailUsage {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens?: number
  readonly routes?: { provider: string; model: string }[]
}

interface ChatData {
  readonly user?: { content: { type: 'text'; text: string }[] }[]
  readonly tail?: { tokenUsage?: TailUsage }[]
  readonly turnOrder?: number[]
}

function turnLocation(turn: number, startSeq: number | undefined, endSeq: number | undefined) {
  return {
    turn,
    start: startSeq === undefined ? undefined : { seq: SessionSeq(startSeq) },
    end: endSeq === undefined ? undefined : { seq: SessionSeq(endSeq) },
    status: 'closed',
    steps: [],
    data: {},
  }
}

function bench(options: {
  members?: Member[]
  sessionId?: SessionId
  turn?: ReturnType<typeof turnLocation>
  turnEndSeq?: number | undefined
  access?: boolean
  chat?: ChatData
  modelSelection?: ModelSelectionProjection
  loomMark?: LoomMarkView | null
  routes?: LoomRoutesState
  branching?: Partial<LoomBranchingState>
  start?: (...args: unknown[]) => Promise<LoomOutcome>
  /** Read state of every cost estimate; a failed read leaves the panel on the turn's own usage. */
  estimate?: LoomReadState<LoomEstimateValue>
  locale?: 'en' | 'zh'
} = {}) {
  const sessions = createSnapshotStore<SessionListState>(listOf(options.members ?? MEMBERS))
  const families = createLoomFamilySources({ sessions })
  const branching = createSnapshotStore<LoomBranchingState>({ sets: [], forms: {}, marks: {}, ...options.branching })
  const routes = createSnapshotStore<LoomRoutesState>(options.routes ?? { status: 'idle' })
  const estimate = createSnapshotStore<LoomReadState<LoomEstimateValue>>(options.estimate ?? { status: 'failed' })
  const estimateKeys: string[] = []
  const chatData = options.chat ?? {
    user: [{ content: [{ type: 'text', text: 'Go with C' }, { type: 'text', text: 'and test it' }] }],
    tail: [{ tokenUsage: { uncachedInputTokens: 100, outputTokens: 100, totalTokens: 1100, cacheReadTokens: 900, routes: [{ provider: 'openrouter', model: 'v4' }] } }],
    turnOrder: [1, 2],
  }
  const chat = {
    nodes: { turnDataSource: (_turn: number, kind: string) => createSnapshotStore(kind === 'user' ? chatData.user ?? [] : chatData.tail ?? []) },
    timeline: { turnOrder: chatData.turnOrder ?? [1, 2] },
  }
  const projections: Record<string, unknown> = { modelSelection: options.modelSelection, loomMark: options.loomMark }
  const injected = {
    openSession: vi.fn(),
    refreshProjection: vi.fn(),
    openForm: vi.fn(),
    closeForm: vi.fn(),
    setMark: vi.fn(async (): Promise<LoomOutcome> => ({ ok: true })),
    startBranches: vi.fn(options.start ?? (async (): Promise<LoomOutcome> => ({ ok: true }))),
    loadRoutes: vi.fn(),
  }
  const turn = options.turn ?? turnLocation(2, 15, 30)
  const props: LoomTailProps = {
    sessionId: options.sessionId ?? B,
    messageId: 'm-1' as MessageId,
    turn,
    ...'turnEndSeq' in options ? options.turnEndSeq === undefined ? {} : { turnEndSeq: SessionSeq(options.turnEndSeq) } : { turnEndSeq: SessionSeq(30) },
    useSessions: bindSnapshotSelector(sessions),
    useAccess: () => options.access ?? true,
    useChat: (select: (snapshot: typeof chat) => unknown) => select(chat),
    useProjection: (key: string, select?: (value: unknown) => unknown) =>
      select === undefined ? projections[key] : select(projections[key]),
    useLoomFamily: keyed<LoomFamilyState>(key => families.source(key)),
    useLoomBranching: bindSnapshotSelector(branching),
    useLoomRoutes: bindSnapshotSelector(routes),
    useLoomEstimate: keyed<LoomReadState<LoomEstimateValue>>((key) => {
      estimateKeys.push(key)
      return estimate
    }),
    t: options.locale === 'zh' ? tZh : tEn,
    ...injected,
  } as never
  return { props, injected, branching, routes, sessions, estimate, estimateKeys }
}

describe('Branch ×N caret', () => {
  it('opens the form for this Turn, reports it open, and closes it', () => {
    const { props, injected, branching } = bench()
    render(<BranchCaret {...props} />)
    const caret = screen.getByRole('button', { name: 'Branch several' })
    expect(caret.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(caret)
    expect(injected.openForm).toHaveBeenCalledWith(B, { sourceSessionId: B, afterTurn: 2 })
    act(() => { branching.set({ sets: [], marks: {}, forms: { [B]: { sourceSessionId: B, afterTurn: 2, rows: [''], samples: 1, selection: null, isolation: 'shared', isolationUnavailable: null, starting: false, failure: null } } }) })
    expect(caret.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(caret)
    expect(injected.closeForm).toHaveBeenCalledWith(B)
  })

  it('renders nothing before the Turn ends or without branch access', () => {
    render(<BranchCaret {...bench({ turnEndSeq: undefined }).props} />)
    render(<BranchCaret {...bench({ access: false }).props} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('names itself in a tooltip only on a hover device, following capability changes', () => {
    const hover = stubHover(false)
    render(<BranchCaret {...bench().props} />)
    const caret = screen.getByRole('button', { name: 'Branch several' })
    fireEvent.mouseEnter(caret)
    expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => { hover.change(true) })
    fireEvent.mouseEnter(caret)
    expect(document.body.textContent).toContain('Branch several')
  })
})

describe('variant pager', () => {
  it('steps between the variants of the cut on the first own Turn with one tab stop', () => {
    const { props, injected } = bench()
    render(<VariantPager {...props} />)
    const pager = screen.getByRole('group', { name: 'Variant 2 of 3' })
    const [previous, next] = within(pager).getAllByRole('button') as [HTMLElement, HTMLElement]
    expect(pager.textContent).toContain('2/3')
    expect([previous.tabIndex, next.tabIndex]).toEqual([-1, 0])
    fireEvent.click(previous)
    expect(injected.openSession).toHaveBeenLastCalledWith(A)
    fireEvent.click(next)
    expect(injected.openSession).toHaveBeenLastCalledWith(C)
    act(() => { next.focus() })
    fireEvent.keyDown(next, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(previous)
    fireEvent.keyDown(previous, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(next)
    fireEvent.keyDown(next, { key: 'Home' })
    expect(injected.openSession).toHaveBeenLastCalledWith(A)
    fireEvent.keyDown(next, { key: 'End' })
    expect(injected.openSession).toHaveBeenLastCalledWith(C)
    expect(fireEvent.keyDown(next, { key: 'a' })).toBe(true)
    expect(injected.openSession).toHaveBeenCalledTimes(4)
  })

  it('marks the missing neighbour of an end variant unavailable and keeps the tab stop on the other button', () => {
    const { props, injected } = bench({ sessionId: C, locale: 'zh' })
    render(<VariantPager {...props} />)
    const pager = screen.getByRole('group', { name: '变体 3/3' })
    const [previous, next] = within(pager).getAllByRole('button') as [HTMLElement, HTMLElement]
    expect(next.getAttribute('aria-disabled')).toBe('true')
    expect([previous.tabIndex, next.tabIndex]).toEqual([0, -1])
    fireEvent.click(next)
    fireEvent.keyDown(previous, { key: 'End' })
    expect(injected.openSession).not.toHaveBeenCalled()
  })

  it('marks the first variant without a previous one', () => {
    const { props, injected } = bench({ sessionId: A })
    render(<VariantPager {...props} />)
    const [previous, next] = within(screen.getByRole('group', { name: 'Variant 1 of 3' })).getAllByRole('button') as [HTMLElement, HTMLElement]
    expect(previous.getAttribute('aria-disabled')).toBe('true')
    expect(next.getAttribute('aria-disabled')).toBeNull()
    fireEvent.keyDown(next, { key: 'Home' })
    expect(injected.openSession).not.toHaveBeenCalled()
  })

  it('renders nothing on other Turns, for an inherited Turn, for the root, or for a single variant', () => {
    render(<VariantPager {...bench({ turn: turnLocation(3, 40, 50) }).props} />)
    render(<VariantPager {...bench({ turn: turnLocation(2, 5, 30) }).props} />)
    render(<VariantPager {...bench({ sessionId: ROOT }).props} />)
    render(<VariantPager {...bench({ members: MEMBERS.slice(0, 2), sessionId: A }).props} />)
    expect(screen.queryByRole('group')).toBeNull()
    render(<VariantPager {...bench({ turn: turnLocation(2, undefined, 30) }).props} />)
    expect(screen.getByRole('group', { name: 'Variant 2 of 3' })).toBeTruthy()
  })

  it('renders no body for a Session without a cut or before its family loads', () => {
    render(<VariantPagerBody {...bench({ sessionId: ROOT }).props} />)
    const { props, sessions } = bench()
    act(() => { sessions.set({ ...sessions.getSnapshot(), phase: 'pending' }) })
    render(<VariantPagerBody {...props} />)
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('asks for the Session outline that names the first own Turn', () => {
    const members = MEMBERS.map((member) => {
      if (member.id !== 'b') return member
      const { outline: _outline, ...rest } = member
      return rest
    })
    const { props, injected, sessions } = bench({ members })
    render(<VariantPager {...props} />)
    expect(injected.refreshProjection).toHaveBeenCalledWith(B)
    act(() => { sessions.set({ ...sessions.getSnapshot(), phase: 'pending' }) })
  })
})

describe('Regenerate', () => {
  it('regenerates once from the main part and reports a failure beside it', async () => {
    const results: LoomOutcome[] = [{ ok: true }, { ok: false, failure: { code: 'loom/turn-unavailable', reason: 'not-user-opened', unknownOutcome: false } }]
    const { props, injected } = bench({ start: async () => results.shift()! })
    render(<RegenerateSplit {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate once' }))
    expect(injected.startBranches).toHaveBeenCalledWith({ kind: 'regenerate', sessionId: B, turn: 2, count: 1 }, { ownerSessionId: B })
    await act(async () => {})
    // A start from the main part moves no focus.
    expect(document.activeElement).toBe(document.body)
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate once' }))
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'A user prompt did not open this turn')
  })

  it('opens a panel that resends the prompt ×N on the route, names the folder and the turn usage, and closes when it starts', async () => {
    const { props, injected } = bench()
    render(<RegenerateSplit {...props} />)
    const caret = screen.getByRole('button', { name: 'Regenerate several' })
    fireEvent.click(caret)
    const panel = screen.getByRole('dialog', { name: 'Regenerate turn 2' })
    // The placed panel takes focus on its checked count.
    expect(document.activeElement).toBe(within(panel).getByRole('radio', { name: '×1' }))
    expect(injected.loadRoutes).toHaveBeenCalledOnce()
    expect(panel.textContent).toContain('Go with C and test it')
    expect(panel.textContent).toContain('openrouter · v4')
    expect(panel.textContent).toContain('Same as this branch')
    expect(panel.textContent).toContain('Children share this folder, including edits earlier branches make')
    expect(panel.textContent).toContain('1.1K tok · 90% cache hit')
    expect(panel.textContent).toContain("This turn's own usage")
    const group = within(panel).getByRole('radiogroup', { name: 'Number of variants' })
    fireEvent.click(within(group).getByRole('radio', { name: '×4' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Regenerate ×4' }))
    expect(injected.startBranches).toHaveBeenCalledWith({ kind: 'regenerate', sessionId: B, turn: 2, count: 4, isolation: 'shared' }, { ownerSessionId: B })
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(caret)
    // Reopened, the panel focuses the count chosen before, not the first one.
    fireEvent.click(caret)
    expect(document.activeElement).toBe(within(screen.getByRole('dialog')).getByRole('radio', { name: '×4' }))
  })

  it('keeps the panel open with the failure, and closes on Escape with focus back on the caret', async () => {
    const { props } = bench({ start: async () => ({ ok: false, failure: { code: 'loom/too-many-branches', limit: 2, unknownOutcome: false } }) })
    render(<RegenerateSplit {...props} />)
    const caret = screen.getByRole('button', { name: 'Regenerate several' })
    fireEvent.click(caret)
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate ×1' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'At most 2 branches per request')
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.keyDown(document, { key: 'a' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(caret)
    fireEvent.click(caret)
    fireEvent.click(caret)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('overrides the route for these branches from the route list', async () => {
    const options = [
      { selection: { provider: 'p', model: 'm' }, providerName: 'P', modelName: 'M', efforts: [] },
      { selection: { provider: 'openrouter', model: 'v4' }, providerName: 'OpenRouter', modelName: 'V4 Flash', efforts: [] },
    ]
    const { props, injected } = bench({ routes: { status: 'ready', options } })
    render(<RegenerateSplit {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate several' }))
    const change = screen.getByRole('button', { name: /Change/u })
    fireEvent.click(change)
    fireEvent.click(screen.getByRole('menuitem', { name: /P · M/u }))
    const panel = screen.getByRole('dialog')
    expect(panel.textContent).toContain('ModelMChange')
    expect(panel.textContent).toContain('For these branches only')
    fireEvent.click(within(panel).getByRole('button', { name: 'Regenerate ×1' }))
    expect(injected.startBranches).toHaveBeenLastCalledWith(expect.objectContaining({ selection: { provider: 'p', model: 'm' } }), { ownerSessionId: B })
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate several' }))
    fireEvent.click(screen.getByRole('button', { name: /Change/u }))
    fireEvent.click(screen.getByRole('button', { name: /Change/u }))
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Change/u }))
    fireEvent.pointerDown(screen.getByRole('dialog').querySelector('p')!)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Change/u }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Change/u }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Same as this branch/u }))
    // The turn's first route reads by the catalog's display name.
    expect(screen.getByRole('dialog').textContent).toContain('ModelV4 FlashChange')
  })

  it('chooses where the branches keep their files, falls back with the Host\'s reason after a refusal, and tries again on reopening', async () => {
    const refusal: LoomOutcome = { ok: false, failure: { code: 'loom/isolation-unavailable', isolationReason: 'no-repository', unknownOutcome: false } }
    const start = vi.fn<(...args: unknown[]) => Promise<LoomOutcome>>().mockResolvedValueOnce(refusal).mockResolvedValue({ ok: true })
    const { props, injected } = bench({ start })
    render(<RegenerateSplit {...props} />)
    const caret = screen.getByRole('button', { name: 'Regenerate several' })
    fireEvent.click(caret)
    const panel = screen.getByRole('dialog')
    const group = within(panel).getByRole('radiogroup', { name: 'Where branches keep their files' })
    const shared = within(group).getByRole('radio', { name: /Run one at a time in the shared folder/u })
    const worktree = within(group).getByRole('radio', { name: /Isolate each branch in a worktree/u })
    expect([shared.getAttribute('aria-checked'), worktree.getAttribute('aria-checked')]).toEqual(['true', 'false'])
    expect(worktree.textContent).toContain('Untracked files are not carried over.')
    fireEvent.click(worktree)
    expect(worktree.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(panel).getByRole('button', { name: 'Regenerate ×1' }))
    expect(injected.startBranches).toHaveBeenLastCalledWith(expect.objectContaining({ isolation: 'worktree' }), { ownerSessionId: B })
    await act(async () => {})
    expect(shared.getAttribute('aria-checked')).toBe('true')
    expect(worktree).toHaveProperty('disabled', true)
    expect(worktree.textContent).toContain('Not available: this folder is not in a git repository')
    expect(within(panel).getByRole('alert').textContent).toContain('Worktree isolation is unavailable')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(caret)
    expect(within(screen.getByRole('dialog')).getByRole('radio', { name: /Isolate each branch in a worktree/u })).toHaveProperty('disabled', false)
    // The one-click part leaves the folder choice to the Host.
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate once' }))
    expect(injected.startBranches).toHaveBeenLastCalledWith({ kind: 'regenerate', sessionId: B, turn: 2, count: 1 }, { ownerSessionId: B })
  })

  it('moves between the folder choices with the arrow keys, and stays on the shared folder once worktrees are refused', () => {
    const { props } = bench()
    render(<RegenerateSplit {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate several' }))
    const group = screen.getByRole('radiogroup', { name: 'Where branches keep their files' })
    const shared = within(group).getByRole('radio', { name: /shared folder/u })
    const worktree = within(group).getByRole('radio', { name: /worktree/u })
    fireEvent.keyDown(shared, { key: 'a' })
    expect(shared.getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(shared, { key: 'ArrowDown' })
    expect(worktree.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(worktree)
    fireEvent.keyDown(worktree, { key: 'ArrowUp' })
    expect(shared.getAttribute('aria-checked')).toBe('true')
  })

  it('reads the cost of the branches from the estimate: list price, tokens without a price, or the turn\'s own usage when it fails', () => {
    const ready = (value: LoomEstimateValue): LoomReadState<LoomEstimateValue> => ({ status: 'ready', value, refreshing: false, stale: false })
    const open = (estimate: LoomReadState<LoomEstimateValue>, extra: Parameters<typeof bench>[0] = {}): HTMLElement => {
      cleanup()
      render(<RegenerateSplit {...bench({ estimate, ...extra }).props} />)
      fireEvent.click(screen.getByRole('button', { name: 'Regenerate several' }))
      return screen.getByRole('dialog')
    }
    expect(open({ status: 'loading' }).textContent).toContain('Estimating…')
    const priced = open(ready({ priced: true, perBranch: { low: 0.006, high: 0.01 }, total: { low: 0.006, high: 0.01 }, cacheShare: 0.5, basis: 'own-turn' }))
    expect(priced.textContent).toContain('≈ $0.006–$0.010 per branch · list price')
    expect(priced.textContent).toContain("50% of input was cached in this turn's own run")
    expect(priced.textContent).not.toContain("This turn's own usage")
    expect(open(ready({ priced: false, perBranch: { low: 12_000, high: 15_000 }, cacheShare: 0, basis: 'own-turn' })).textContent)
      .toContain('≈ 12K–15K tokens per branch · no list price for this route')
    expect(open(ready({ priced: false, cacheShare: 0, basis: 'own-turn' })).textContent).toContain('No estimate yet')
    // A failed estimate falls back to the turn's own usage, and to nothing without one.
    expect(open({ status: 'failed' }).textContent).toContain("This turn's own usage")
    expect(open({ status: 'failed' }, { chat: { user: [{ content: [{ type: 'text', text: 'Again' }] }], tail: [] } }).textContent).not.toContain('Usage')
  })

  it('reads the estimate for the turn, variant count, and selected route', () => {
    const options = [{ selection: { provider: 'p', model: 'm' }, providerName: 'P', modelName: 'M', efforts: [] }]
    const { props, estimateKeys } = bench({ routes: { status: 'ready', options }, estimate: { status: 'ready', value: { priced: true, perBranch: { low: 1, high: 2 }, cacheShare: 0, basis: 'family' }, refreshing: false, stale: false } })
    render(<RegenerateSplit {...props} />)
    expect(estimateKeys).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate several' }))
    expect(estimateKeys.at(-1)).toBe(['b', 'regenerate', '2', '', '1'].join('\u0000'))
    fireEvent.click(screen.getByRole('radio', { name: '×4' }))
    expect(estimateKeys.at(-1)).toBe(['b', 'regenerate', '2', '', '4'].join('\u0000'))
    expect(screen.getByRole('dialog').textContent).not.toContain('not this override')
    fireEvent.click(screen.getByRole('button', { name: /Change/u }))
    fireEvent.click(screen.getByRole('menuitem', { name: /P · M/u }))
    expect(estimateKeys.at(-1)).toBe(['b', 'regenerate', '2', '', '4', JSON.stringify({ provider: 'p', model: 'm' })].join('\u0000'))
    expect(screen.getByRole('dialog').textContent).not.toContain('not this override')
  })

  it('names its parts in tooltips on a hover device while the panel is closed', () => {
    stubHover(true)
    const { props } = bench({ chat: { user: [{ content: [{ type: 'image', text: '' } as never, { type: 'text', text: 'Only text' }] }], tail: [] } })
    render(<RegenerateSplit {...props} />)
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Regenerate several' }))
    expect(document.body.textContent).toContain('Regenerate several')
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate several' }))
    expect(screen.getByRole('dialog').textContent).toContain('Only text')
  })

  it('shows the route the turn started on, not the one it ended on, and the Session\'s last route only on the latest turn', () => {
    const usage = { uncachedInputTokens: 10, outputTokens: 5, totalTokens: 15, routes: [{ provider: 'p', model: 'first' }, { provider: 'p', model: 'fallback' }] }
    const chat = (turnOrder: number[], tokenUsage?: TailUsage): ChatData => ({
      user: [{ content: [{ type: 'text', text: 'Again' }] }], tail: [tokenUsage === undefined ? {} : { tokenUsage }], turnOrder,
    })
    const modelSelection = { lastUsed: { provider: 'p', model: 'last' }, next: null }
    render(<RegenerateSplit {...bench({ chat: chat([1, 2], usage), modelSelection }).props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate several' }))
    expect(screen.getByRole('dialog').textContent).toContain('p · first')
    expect(screen.getByRole('dialog').textContent).not.toContain('fallback')
    cleanup()
    // An earlier turn without recorded routes says so; the Session's last route is not its route.
    const unrouted = chat([2, 3], { uncachedInputTokens: 10, outputTokens: 5, totalTokens: 15 })
    render(<RegenerateSplit {...bench({ chat: unrouted, modelSelection }).props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate several' }))
    expect(screen.getByRole('dialog').textContent).toContain('No route recorded yet')
    expect(screen.getByRole('dialog').textContent).not.toContain('last')
  })

  it('falls back to the last used route, then to no route, and shows tokens without a cache share', () => {
    const { props } = bench({
      chat: { user: [{ content: [{ type: 'text', text: 'Again' }] }], tail: [{ tokenUsage: { uncachedInputTokens: 10, outputTokens: 5, totalTokens: 15 } }] },
      modelSelection: { lastUsed: { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' }, next: null },
    })
    render(<RegenerateSplit {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate several' }))
    expect(screen.getByRole('dialog').textContent).toContain('deepseek · chat · high')
    expect(screen.getByRole('dialog').textContent).toContain('15 tok')
    cleanup()
    render(<RegenerateSplit {...bench({ chat: { user: [{ content: [{ type: 'text', text: 'Again' }] }], tail: [{}] } }).props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate several' }))
    expect(screen.getByRole('dialog').textContent).toContain('No route recorded yet')
    expect(screen.getByRole('dialog').textContent).not.toContain('Usage')
  })

  it('renders nothing for a Turn without a user prompt, before it ends, or without access', () => {
    render(<RegenerateSplit {...bench({ chat: { user: [], tail: [] } }).props} />)
    render(<RegenerateSplit {...bench({ turnEndSeq: undefined }).props} />)
    render(<RegenerateSplit {...bench({ access: false }).props} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('count choice', () => {
  it('moves and selects with the arrows, jumps with Home and End, and ignores the current count', () => {
    const onChange = vi.fn()
    const { rerender } = render(<CountChoice values={[1, 2, 4]} value={2} label="Count" format={count => `×${String(count)}`} onChange={onChange} />)
    const two = screen.getByRole('radio', { name: '×2' })
    expect(two.getAttribute('aria-checked')).toBe('true')
    expect(two.tabIndex).toBe(0)
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']) fireEvent.keyDown(two, { key })
    expect(onChange.mock.calls).toEqual([[4], [4], [1], [1], [1], [4]])
    expect(fireEvent.keyDown(two, { key: 'a' })).toBe(true)
    fireEvent.click(two)
    expect(onChange).toHaveBeenCalledTimes(6)
    rerender(<CountChoice values={[1, 2, 4]} value={4} label="Count" format={count => `×${String(count)}`} onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole('radio', { name: '×4' }), { key: 'End' })
    expect(onChange).toHaveBeenCalledTimes(6)
  })
})

describe('private marks', () => {
  it('toggles Keep and Set aside on the latest Turn of a family member', () => {
    const { props, injected, branching } = bench({ loomMark: { mark: 'keep' }, locale: 'zh' })
    render(<MarkGroup {...props} />)
    const group = screen.getByRole('group', { name: '私人标记' })
    const [keep, setAside] = within(group).getAllByRole('button') as [HTMLElement, HTMLElement]
    expect(keep.getAttribute('aria-label')).toBe('保留')
    expect(setAside.getAttribute('aria-label')).toBe('搁置')
    expect(keep.getAttribute('aria-description')).toBe(tZh('marks.keepHint'))
    expect(setAside.getAttribute('aria-description')).toBe(tZh('marks.setAsideHint'))
    expect([keep.getAttribute('aria-pressed'), setAside.getAttribute('aria-pressed')]).toEqual(['true', 'false'])
    fireEvent.click(keep)
    expect(injected.setMark).toHaveBeenLastCalledWith(B, null)
    fireEvent.click(setAside)
    expect(injected.setMark).toHaveBeenLastCalledWith(B, 'set-aside')
    act(() => { branching.set({ sets: [], forms: {}, marks: { [B]: { status: 'saving', mark: 'set-aside' } } }) })
    expect(setAside.getAttribute('aria-pressed')).toBe('true')
    expect((keep as HTMLButtonElement).disabled).toBe(true)
    act(() => { branching.set({ sets: [], forms: {}, marks: { [B]: { status: 'failed', failure: { code: 'session/not-found', unknownOutcome: false } } } }) })
    expect(screen.getByRole('status').textContent).toBe('找不到此会话')
    expect(keep.getAttribute('aria-pressed')).toBe('true')
  })

  it('renders nothing on an earlier Turn, outside a family, or without access', () => {
    render(<MarkGroup {...bench({ chat: { turnOrder: [1, 2, 3] } }).props} />)
    render(<MarkGroup {...bench({ members: [{ id: 'b' }] }).props} />)
    render(<MarkGroup {...bench({ access: false }).props} />)
    expect(screen.queryByRole('group')).toBeNull()
  })
})
