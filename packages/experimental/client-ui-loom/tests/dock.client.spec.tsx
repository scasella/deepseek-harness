// @vitest-environment jsdom
/** The Branch ×N form and the running-branches strip in the input dock, and Edit & branch under a user message. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { KeyedSnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { BranchForm } from '../src/client/BranchForm.tsx'
import type { LoomSetId, LoomSetStatus } from '@deepseek-ai/dsh-experimental-loom/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createLoomBranching, type LoomBranchForm, type LoomBranchingState, type LoomOutcome, type LoomTrackedSet } from '../src/client/branching.ts'
import type { LoomDockProps } from '../src/client/dock.ts'
import { EditBranch, type EditBranchProps } from '../src/client/EditBranch.tsx'
import { createLoomFamilySources, type LoomFamilyState } from '../src/client/family.ts'
import type { LoomReadState } from '../src/client/read-sources.ts'
import type { LoomRoutesState } from '../src/client/routes.ts'
import type { LoomEstimateValue } from '@deepseek-ai/dsh-experimental-loom/types'
import { RunningStrip } from '../src/client/RunningStrip.tsx'
import { entry, listOf, ROOT, SET, SET2, tEn, tZh, type Member } from './fixtures.client.ts'

const A = SessionId('a')
const B = SessionId('b')

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

function keyed<T>(source: (key: string) => ObservableSnapshot<T>): KeyedSnapshotSelectorHook<T> {
  return ((key: string, select?: (value: T | undefined) => unknown, equal?: (left: unknown, right: unknown) => boolean): unknown =>
    bindSnapshotSelector(source(key))(value => select === undefined ? value : select(value), equal)) as KeyedSnapshotSelectorHook<T>
}

const MEMBERS: Member[] = [
  { id: 'root', title: 'Root task' },
  { id: 'a', parent: 'root', cutSeq: 10, cutTurn: 1, createdAt: 1, branch: { setId: SET, kind: 'steer', index: 0 }, title: 'Clamp' },
  { id: 'b', parent: 'root', cutSeq: 10, cutTurn: 1, createdAt: 2, branch: { setId: SET2, kind: 'steer', index: 0 }, title: 'Other set' },
]

function form(extra: Partial<LoomBranchForm> = {}): LoomBranchForm {
  return { sourceSessionId: ROOT, afterTurn: 2, rows: ['Try A', 'Try A'], samples: 1, selection: null, isolation: 'shared', isolationUnavailable: null, starting: false, failure: null, ...extra }
}

function bench(options: {
  members?: Member[]
  sessionId?: SessionId
  branching?: Partial<LoomBranchingState>
  statuses?: SessionStatusSnapshot
  routes?: LoomRoutesState
  /** Route of the next request in the Session's own projection. */
  next?: { provider: string; model: string }
  /** Turns Chat holds, and the routes each turn's tail reports. */
  chat?: { turnOrder: number[]; routes?: Record<number, { provider: string; model: string }[]> }
  locale?: 'en' | 'zh'
  cancel?: () => Promise<LoomOutcome>
  submit?: () => Promise<boolean>
  /** Read state of every cost estimate; a failed read shows no Cost row. */
  estimate?: LoomReadState<LoomEstimateValue>
} = {}) {
  const sessions = createSnapshotStore<SessionListState>(listOf(options.members ?? MEMBERS))
  const families = createLoomFamilySources({ sessions })
  const branching = createSnapshotStore<LoomBranchingState>({ sets: [], forms: {}, marks: {}, ...options.branching })
  const statuses = createSnapshotStore<SessionStatusSnapshot>(options.statuses ?? new Map())
  const routes = createSnapshotStore<LoomRoutesState>(options.routes ?? { status: 'idle' })
  const estimate = createSnapshotStore<LoomReadState<LoomEstimateValue>>(options.estimate ?? { status: 'failed' })
  const estimateKeys: string[] = []
  const injected = {
    openSession: vi.fn(),
    refreshProjection: vi.fn(),
    editForm: vi.fn(),
    closeForm: vi.fn(),
    submitForm: vi.fn(options.submit ?? (async () => true)),
    loadRoutes: vi.fn(),
    adoptSet: vi.fn(),
    refreshSet: vi.fn(),
    dismissSet: vi.fn(),
    cancelBranches: vi.fn(options.cancel ?? (async (): Promise<LoomOutcome> => ({ ok: true }))),
  }
  const chatData = options.chat ?? { turnOrder: [1, 2] }
  const chat = {
    nodes: {
      turnDataSource: (turn: number) => createSnapshotStore(
        chatData.routes?.[turn] === undefined ? [] : [{ tokenUsage: { routes: chatData.routes[turn] } }],
      ),
    },
    timeline: { turnOrder: chatData.turnOrder },
  }
  const props: LoomDockProps = {
    sessionId: options.sessionId ?? ROOT,
    useSessions: bindSnapshotSelector(sessions),
    useSessionStatus: bindSnapshotSelector(statuses),
    useChat: (select: (snapshot: typeof chat) => unknown) => select(chat),
    useProjection: (_key: string, select: (value: unknown) => unknown) =>
      select(options.next === undefined ? undefined : { lastUsed: null, next: options.next }),
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
  return { props, injected, branching, statuses, sessions, estimate, estimateKeys }
}

describe('Branch ×N form', () => {
  it('renders nothing until a form opens for this dock', () => {
    const { props } = bench()
    const { container } = render(<BranchForm {...props} />)
    expect(container.innerHTML).toBe('')
  })

  it('edits one steering line per branch, notes repeated lines, and starts the branches', () => {
    const { props, injected } = bench({ branching: { forms: { [ROOT]: form() } }, next: { provider: 'openrouter', model: 'v4' } })
    render(<BranchForm {...props} />)
    const panel = screen.getByRole('region', { name: 'Branch after turn 2' })
    expect(panel.textContent).toContain('2 branches')
    expect(panel.textContent).toContain('Rows 1 and 2 share a line: samples of one prompt')
    expect(panel.textContent).toContain('openrouter · v4')
    expect(panel.textContent).toContain('Same as parent')
    expect(panel.textContent).toContain('Nothing runs until you start')
    const second = within(panel).getByRole('textbox', { name: 'Steering line 2' })
    expect(second.getAttribute('placeholder')).toBe('What should this branch do?')
    fireEvent.change(second, { target: { value: 'Try B' } })
    expect(injected.editForm).toHaveBeenLastCalledWith(ROOT, { rows: ['Try A', 'Try B'] })
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove line 1' }))
    expect(injected.editForm).toHaveBeenLastCalledWith(ROOT, { rows: ['Try A'] })
    fireEvent.click(within(panel).getByRole('button', { name: 'Add branch' }))
    expect(injected.editForm).toHaveBeenLastCalledWith(ROOT, { rows: ['Try A', 'Try A', ''] })
    fireEvent.click(within(panel).getByRole('radio', { name: '×3' }))
    expect(injected.editForm).toHaveBeenLastCalledWith(ROOT, { samples: 3 })
    expect(injected.loadRoutes).toHaveBeenCalledOnce()
    fireEvent.click(within(panel).getByRole('button', { name: 'Start 2 branches' }))
    expect(injected.submitForm).toHaveBeenCalledWith(ROOT)
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }))
    expect(injected.closeForm).toHaveBeenCalledWith(ROOT)
  })

  it('chooses where the branches keep their files, and disables a refused worktree option with the Host\'s reason', () => {
    const { props, injected, branching } = bench({ branching: { forms: { [ROOT]: form() } } })
    render(<BranchForm {...props} />)
    const panel = screen.getByRole('region')
    const shared = within(panel).getByRole('radio', { name: /Run one at a time in the shared folder/u })
    const worktree = within(panel).getByRole('radio', { name: /Isolate each branch in a worktree/u })
    expect(shared.textContent).toContain('Children share this folder, including edits earlier branches make')
    expect(worktree.textContent).toContain('Each branch starts from a snapshot of this folder')
    expect(worktree.textContent).toContain('Untracked files are not carried over.')
    fireEvent.click(worktree)
    expect(injected.editForm).toHaveBeenLastCalledWith(ROOT, { isolation: 'worktree' })
    act(() => { branching.set({ sets: [], marks: {}, forms: { [ROOT]: form({ isolation: 'worktree' }) } }) })
    fireEvent.click(shared)
    expect(injected.editForm).toHaveBeenLastCalledWith(ROOT, { isolation: 'shared' })
    act(() => { branching.set({ sets: [], marks: {}, forms: { [ROOT]: form({ isolationUnavailable: 'service-unavailable' }) } }) })
    expect(worktree).toHaveProperty('disabled', true)
    expect(worktree.textContent).toContain('Not available: the worktree service is not running')
    fireEvent.keyDown(shared, { key: 'ArrowDown' })
    expect(injected.editForm).toHaveBeenCalledTimes(2)
    act(() => { branching.set({ sets: [], marks: {}, forms: { [ROOT]: form({ starting: true }) } }) })
    expect([shared, worktree].map(radio => (radio as HTMLButtonElement).disabled)).toEqual([true, true])
  })

  it('reads the cost of the branches once per branch count and kind of set, and says an override is not covered', () => {
    const priced: LoomReadState<LoomEstimateValue> = {
      status: 'ready',
      value: { priced: true, perBranch: { low: 0.006, high: 0.01 }, total: { low: 0.012, high: 0.02 }, cacheShare: 0.887, basis: 'family' },
      refreshing: false,
      stale: false,
    }
    const { props, estimateKeys, branching } = bench({ branching: { forms: { [ROOT]: form() } }, estimate: priced })
    render(<BranchForm {...props} />)
    const text = (): string => screen.getByRole('region').textContent ?? ''
    expect(text()).toContain('≈ $0.006–$0.010 per branch · list price')
    expect(text()).toContain("≈ $0.012–$0.020 for 2 · 88% of input was cached across this family's own turns")
    expect(estimateKeys.at(-1)).toBe(['root', 'steer', '', '2', '2'].join('\u0000'))
    act(() => { branching.set({ sets: [], marks: {}, forms: { [ROOT]: form({ samples: 3 }) } }) })
    expect(estimateKeys.at(-1)).toBe(['root', 'variants', '', '2', '6'].join('\u0000'))
    expect(text()).not.toContain('not this override')
    act(() => { branching.set({ sets: [], marks: {}, forms: { [ROOT]: form({ selection: { provider: 'p', model: 'm' } }) } }) })
    expect(estimateKeys.at(-1)).toBe(['root', 'steer', '', '2', '2', JSON.stringify({ provider: 'p', model: 'm' })].join('\u0000'))
    // Typing a steering line changes nothing the estimate reads.
    const before = estimateKeys.length
    act(() => { branching.set({ sets: [], marks: {}, forms: { [ROOT]: form({ rows: ['Try A', 'Try B'], selection: { provider: 'p', model: 'm' } }) } }) })
    expect(new Set(estimateKeys.slice(before))).toEqual(new Set([estimateKeys.at(-1)]))
  })

  it('shows the cost while it reads, in tokens without a price, and no Cost row when the estimate fails', () => {
    const states: [LoomReadState<LoomEstimateValue>, string | null][] = [
      [{ status: 'loading' }, 'Estimating…'],
      [{ status: 'ready', value: { priced: false, perBranch: { low: 10_000, high: 12_000 }, cacheShare: 0, basis: 'own-turn' }, refreshing: true, stale: true }, '≈ 10K–12K tokens per branch · no list price for this route'],
      [{ status: 'failed' }, null],
    ]
    for (const [estimate, expected] of states) {
      cleanup()
      render(<BranchForm {...bench({ branching: { forms: { [ROOT]: form({ rows: ['a'] }) } }, estimate }).props} />)
      const content = screen.getByRole('region').textContent ?? ''
      if (expected === null) expect(content).not.toContain('Cost')
      else expect(content).toContain(expected)
    }
    cleanup()
    render(<BranchForm {...bench({ branching: { forms: { [ROOT]: form() } }, estimate: { status: 'loading' }, locale: 'zh' }).props} />)
    expect(screen.getByRole('region').textContent).toContain('正在估算…')
  })

  it('refuses empty lines, shows a start in flight and its failure, and picks a route for these branches', () => {
    const options = [{ selection: { provider: 'p', model: 'm' }, providerName: 'P', modelName: 'M', efforts: [] }]
    const { props, injected, branching } = bench({ branching: { forms: { [ROOT]: form({ rows: ['Only'], samples: 2 }) } }, routes: { status: 'ready', options } })
    render(<BranchForm {...props} />)
    expect(screen.getByRole('button', { name: 'Start 2 branches' })).toHaveProperty('disabled', false)
    expect(screen.queryByRole('button', { name: /Remove line/u })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Change/u }))
    fireEvent.click(screen.getByRole('menuitem', { name: /P · M/u }))
    expect(injected.editForm).toHaveBeenLastCalledWith(ROOT, { selection: { provider: 'p', model: 'm' } })
    act(() => { branching.set({ sets: [], marks: {}, forms: { [ROOT]: form({ rows: ['Only', ' '], selection: { provider: 'p', model: 'm' } }) } }) })
    expect(screen.getByText('Fill in every line, or remove empty ones')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start 2 branches' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('region').textContent).toContain('For these branches only')
    // The inherited route shows by catalog names once the list has loaded.
    expect(screen.getByRole('region').textContent).toContain('ModelM')
    act(() => { branching.set({ sets: [], marks: {}, forms: { [ROOT]: form({ rows: ['Only'], starting: true }) } }) })
    expect(screen.getByRole('button', { name: 'Start 1 branch' })).toHaveProperty('disabled', true)
    act(() => { branching.set({ sets: [], marks: {}, forms: { [ROOT]: form({ rows: ['Only'], failure: { code: 'loom/too-many-branches', limit: 1, unknownOutcome: false } }) } }) })
    expect(screen.getByRole('alert').textContent).toBe('At most 1 branches per request')
  })

  it('names another source Session and reads its route from the list, only for its last turn', () => {
    const members = MEMBERS.map(member => member.id === 'a' ? { ...member, outline: [entry(1, 0)] } : member)
    const { props, sessions } = bench({ members, sessionId: B, branching: { forms: { [B]: form({ sourceSessionId: A, afterTurn: 1, rows: [''] }) } }, locale: 'zh' })
    const pick = (outline: ReturnType<typeof entry>[]): void => {
      act(() => {
        const list = sessions.getSnapshot()
        const row = list.byId[A]!
        sessions.set({
          ...list,
          byId: {
            ...list.byId,
            [A]: {
              ...row,
              projectionValues: {
                ...row.projectionValues,
                turnOutline: outline,
                modelSelection: { lastUsed: { provider: 'deepseek', model: 'old' }, next: { provider: 'deepseek', model: 'chat' } },
              },
            },
          },
        })
      })
    }
    pick([entry(1, 0)])
    render(<BranchForm {...props} />)
    expect(screen.getByRole('region', { name: '在第 1 轮之后分支 Clamp' }).textContent).toContain('deepseek · chat')
    // An earlier turn of that Session has no route here, and the Session's last route is not its.
    pick([entry(1, 0), entry(2, 20)])
    expect(screen.getByRole('region').textContent).toContain('尚未记录路由')
    expect(screen.getByRole('region').textContent).not.toContain('deepseek')
    cleanup()
    render(<BranchForm {...bench({ sessionId: B, branching: { forms: { [B]: form({ sourceSessionId: ROOT, rows: [''] }) } } }).props} />)
    expect(screen.getByRole('region').textContent).toContain('No route recorded yet')
  })

  it('shows the route the cut turn kept: the next request after the last turn, else what the turn or its successor used', () => {
    const next = { provider: 'p', model: 'pending' }
    const cases: [string, number, NonNullable<NonNullable<Parameters<typeof bench>[0]>['chat']>, string][] = [
      ['the last turn takes the pending pick', 2, { turnOrder: [1, 2], routes: { 1: [{ provider: 'p', model: 'one' }] } }, 'p · pending'],
      ['an earlier turn takes the route its successor started on', 1, { turnOrder: [1, 2], routes: { 1: [{ provider: 'p', model: 'one' }], 2: [{ provider: 'p', model: 'two' }, { provider: 'p', model: 'late' }] } }, 'p · two'],
      ['an earlier turn takes the last route it used when the successor reports none', 1, { turnOrder: [1, 2], routes: { 1: [{ provider: 'p', model: 'one' }, { provider: 'p', model: 'one-late' }] } }, 'p · one-late'],
      ['an earlier turn with no recorded route shows none', 1, { turnOrder: [1, 2] }, 'No route recorded yet'],
    ]
    for (const [name, afterTurn, chat, expected] of cases) {
      cleanup()
      const { props } = bench({ branching: { forms: { [ROOT]: form({ afterTurn, rows: [''] }) } }, next, chat })
      render(<BranchForm {...props} />)
      expect(screen.getByRole('region').textContent, name).toContain(expected)
      // The pending pick belongs to the cut at the last turn only.
      if (afterTurn === 1) expect(screen.getByRole('region').textContent, name).not.toContain('pending')
    }
  })

  it('joins the rows that share a line with the list words of each language', () => {
    const rows = ['Same', 'Same', 'Same']
    render(<BranchForm {...bench({ branching: { forms: { [ROOT]: form({ rows }) } } }).props} />)
    expect(screen.getByRole('region').textContent).toContain('Rows 1, 2 and 3 share a line: samples of one prompt')
    cleanup()
    render(<BranchForm {...bench({ branching: { forms: { [ROOT]: form({ rows }) } }, locale: 'zh' }).props} />)
    expect(screen.getByRole('region').textContent).toContain('第 1、2、3 行内容相同：同一提示词的多次采样')
  })
})

describe('Branch ×N form focus', () => {
  /** A form with the Branch ×N caret that opened it, or the Loom tree's tab stop, and an unrelated control. */
  function open(options: NonNullable<Parameters<typeof bench>[0]> = {}, opener: 'caret' | 'tree' | 'none' = 'caret') {
    const made = bench({ branching: { forms: { [ROOT]: form({ rows: ['Only'] }) } }, ...options })
    const view = render(
      <>
        {opener === 'caret' && <button type="button" data-loom-branch-caret="" aria-expanded="true">caret</button>}
        {opener === 'tree' && <div data-loom-row="session:root" tabIndex={0}>tree row</div>}
        <input aria-label="elsewhere" />
        <BranchForm {...made.props} />
      </>,
    )
    const opens = opener === 'none' ? null : view.container.querySelector<HTMLElement>(opener === 'caret' ? '[data-loom-branch-caret]' : '[data-loom-row]')
    return { ...made, opens, view }
  }

  it('returns focus to the caret that opened the form when Cancel closes it', () => {
    const { injected, opens } = open()
    screen.getByRole('button', { name: 'Cancel' }).focus()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(injected.closeForm).toHaveBeenCalledWith(ROOT)
    expect(document.activeElement).toBe(opens)
  })

  it('closes on Escape from a line and returns focus, to the Loom tree stop when no caret opened it', () => {
    const { injected, opens } = open({}, 'tree')
    const line = screen.getByRole('textbox', { name: 'Steering line 1' })
    line.focus()
    fireEvent.keyDown(line, { key: 'a' })
    expect(injected.closeForm).not.toHaveBeenCalled()
    fireEvent.keyDown(line, { key: 'Escape' })
    expect(injected.closeForm).toHaveBeenCalledWith(ROOT)
    expect(document.activeElement).toBe(opens)
  })

  it('leaves Escape to an open route menu and to an ending composition', () => {
    const options = [{ selection: { provider: 'p', model: 'm' }, providerName: 'P', modelName: 'M', efforts: [] }]
    const { injected } = open({ routes: { status: 'ready', options } })
    const line = screen.getByRole('textbox', { name: 'Steering line 1' })
    line.focus()
    fireEvent.keyDown(line, { key: 'Escape', isComposing: true })
    expect(injected.closeForm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Change/u }))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(line, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(injected.closeForm).not.toHaveBeenCalled()
  })

  it('moves focus after a start that closed the form, and not after one that failed or when focus went elsewhere', async () => {
    const results = [true, false, true]
    // As the real caret does, collapse once the Host has started the branches and closed the form.
    let caret: HTMLElement | null = null
    const submit = async (): Promise<boolean> => {
      const started = results.shift()!
      if (started) caret?.setAttribute('aria-expanded', 'false')
      return started
    }
    const { injected, opens } = open({ submit })
    caret = opens
    const start = screen.getByRole('button', { name: 'Start 1 branch' })
    start.focus()
    fireEvent.click(start)
    await act(async () => {})
    expect(injected.submitForm).toHaveBeenCalledWith(ROOT)
    expect(document.activeElement).toBe(opens)
    start.focus()
    fireEvent.click(start)
    await act(async () => {})
    expect(document.activeElement).toBe(start)
    const elsewhere = screen.getByRole('textbox', { name: 'elsewhere' })
    elsewhere.focus()
    fireEvent.click(start)
    await act(async () => {})
    expect(document.activeElement).toBe(elsewhere)
  })

  it('has no control to return to when neither the caret nor the tree opened the form', () => {
    open({}, 'none')
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    cancel.focus()
    fireEvent.click(cancel)
    expect(document.activeElement).toBe(cancel)
  })
})

function tracked(extra: Partial<LoomTrackedSet> = {}): LoomTrackedSet {
  return {
    setId: SET, sourceSessionId: ROOT, ownerSessionId: ROOT, kind: 'steer', lines: ['Clamp it', 'Second idea'], lost: false, reads: 0,
    children: [{ index: 0, state: 'started', sessionId: A }, { index: 1, state: 'queued' }, { index: 2, state: 'failed', code: 'gateway/internal' }],
    ...extra,
  }
}

describe('running strip', () => {
  it('renders nothing while no set runs', () => {
    const { container } = render(<RunningStrip {...bench().props} />)
    expect(container.innerHTML).toBe('')
  })

  it('counts and lists the children, opens a started one, and withdraws queued ones', async () => {
    const results: LoomOutcome[] = [{ ok: true }, { ok: false, failure: { code: 'loom/set-not-found', unknownOutcome: false } }]
    const statuses: SessionStatusSnapshot = new Map([[A, { running: true, pendingInteraction: undefined, completionUnread: false }]])
    const { props, injected } = bench({ branching: { sets: [tracked()] }, statuses, cancel: async () => results.shift()! })
    render(<RunningStrip {...props} />)
    const strip = screen.getByRole('region', { name: 'Running branches' })
    expect(within(strip).getByRole('status').textContent).toBe('1 running · 1 queued · 1 failed')
    const items = [...strip.querySelectorAll('li')].map(item => [item.getAttribute('data-loom-strip-item'), item.textContent])
    expect(items).toEqual([
      ['running', 'Clamp itrunning'],
      ['queued', 'Second ideaqueuedCancel'],
      ['failed', 'Branch 3failed · The request failed (gateway/internal)'],
    ])
    fireEvent.click(within(strip).getByRole('button', { name: 'Open Clamp it' }))
    expect(injected.openSession).toHaveBeenCalledWith(A)
    fireEvent.click(within(strip).getByRole('button', { name: 'Cancel Second idea' }))
    expect(injected.cancelBranches).toHaveBeenLastCalledWith(SET, [1])
    await act(async () => {})
    fireEvent.click(within(strip).getByRole('button', { name: 'Cancel queued' }))
    expect(injected.cancelBranches).toHaveBeenLastCalledWith(SET, undefined)
    expect(await within(strip).findByRole('alert')).toHaveProperty('textContent', 'The Host no longer holds this branch set')
    expect(injected.refreshSet).toHaveBeenCalledWith(SET)
  })

  it('names a row by its line or position, never by its Session title, and explains each failed fork with a next step', () => {
    const regenerated = tracked({
      kind: 'regenerate',
      lines: [],
      children: [
        { index: 0, state: 'started', sessionId: A },
        { index: 1, state: 'failed', code: 'session/fork-unavailable' },
        { index: 2, state: 'failed', code: 'session/workspace-attach-failed', sessionId: B },
        { index: 3, state: 'failed', code: 'session/model-unavailable' },
      ],
    })
    const { props, injected } = bench({ branching: { sets: [regenerated] } })
    render(<RunningStrip {...props} />)
    const strip = screen.getByRole('region', { name: 'Running branches' })
    const rows = [...strip.querySelectorAll('li')].map(item => item.textContent)
    expect(rows).toEqual([
      'Branch 1ended',
      'Branch 2failed · Could not create this branch; start it again',
      'Branch 3failed · The branch was created without its workspace; open it to check, or start it again',
      'Branch 4failed · The selected model is unavailable; choose another and start again',
    ])
    // The Sessions' own titles ("Clamp", "Other set") name no row, and a row with a Session opens it under its position.
    expect(strip.textContent).not.toContain('Clamp')
    fireEvent.click(within(strip).getByRole('button', { name: 'Open Branch 3' }))
    expect(injected.openSession).toHaveBeenCalledWith(B)
    expect(within(strip).getByRole('button', { name: 'Open Branch 1' })).toBeTruthy()
  })

  it('reads a waiting set again when a child changes state and asks for missing branch facts', () => {
    const members: Member[] = [...MEMBERS, { id: 'n', parent: 'root', cutSeq: 10 }]
    const { props, injected, statuses } = bench({ members, branching: { sets: [tracked()] } })
    render(<RunningStrip {...props} />)
    expect(injected.refreshSet).toHaveBeenCalledOnce()
    expect(injected.refreshProjection).toHaveBeenCalledWith(SessionId('n'))
    act(() => { statuses.set(new Map([[A, { running: true, pendingInteraction: { kind: 'approval' } as never, completionUnread: false }]])) })
    expect(injected.refreshSet).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status').textContent).toBe('1 need approval · 1 queued · 1 failed')
    act(() => { statuses.set(new Map([[A, { running: true, pendingInteraction: { kind: 'approval' } as never, completionUnread: false }]])) })
    expect(injected.refreshSet).toHaveBeenCalledTimes(2)
  })

  it('reads a waiting set again after a pause until a child whose fork failed before it had a Session shows as failed', async () => {
    vi.useFakeTimers()
    try {
      const queued: LoomSetStatus = { setId: SET, sourceSessionId: ROOT, children: [{ index: 0, state: 'started', sessionId: A }, { index: 1, state: 'queued' }] }
      const failed: LoomSetStatus = {
        ...queued,
        children: [{ index: 0, state: 'started', sessionId: A }, { index: 1, state: 'failed', code: 'session/model-unavailable', message: 'gone' }],
      }
      // The family never changes: the failed fork left no Session behind.
      const answers = [queued, queued, queued, failed]
      const setStatus = vi.fn(async (): Promise<RemoteResult<LoomSetStatus>> => ({ ok: true, value: answers.shift()! }))
      const branching = createLoomBranching({
        branch: vi.fn(), cancel: vi.fn(), mark: vi.fn(), refreshProjection: vi.fn(), openSession: vi.fn(), setStatus,
      })
      branching.adopt({ setId: SET, sourceSessionId: ROOT, ownerSessionId: ROOT })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      const { props } = bench()
      const refreshSet = (setId: LoomSetId): void => { branching.refresh(setId) }
      render(<RunningStrip {...props} useLoomBranching={bindSnapshotSelector(branching.state)} refreshSet={refreshSet} />)
      // Mounting reads the waiting set once; each read that still finds it waiting schedules one more.
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(setStatus).toHaveBeenCalledTimes(2)
      expect(screen.getByRole('status').textContent).toBe('1 queued')
      await act(async () => { await vi.advanceTimersByTimeAsync(1_999) })
      expect(setStatus).toHaveBeenCalledTimes(2)
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(setStatus).toHaveBeenCalledTimes(3)
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      expect(setStatus).toHaveBeenCalledTimes(4)
      expect(screen.getByRole('status').textContent).toBe('1 failed')
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(setStatus).toHaveBeenCalledTimes(4)
      branching.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a scheduled read when the strip unmounts', async () => {
    vi.useFakeTimers()
    try {
      const waiting = tracked({ children: [{ index: 0, state: 'queued' }] })
      const { props, injected } = bench({ members: MEMBERS.slice(0, 1), branching: { sets: [waiting] } })
      const { unmount } = render(<RunningStrip {...props} />)
      expect(injected.refreshSet).toHaveBeenCalledOnce()
      unmount()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(injected.refreshSet).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('adopts a set found running among its children and dismisses a finished set with a failure', () => {
    const statuses: SessionStatusSnapshot = new Map([[B, { running: true, pendingInteraction: undefined, completionUnread: false }]])
    const finished = tracked({ children: [{ index: 0, state: 'started', sessionId: A }, { index: 2, state: 'failed', code: 'session/not-found' }] })
    const { props, injected } = bench({ branching: { sets: [finished] }, statuses, locale: 'zh' })
    render(<RunningStrip {...props} />)
    expect(injected.adoptSet).toHaveBeenCalledWith({ setId: SET2, sourceSessionId: ROOT, ownerSessionId: ROOT })
    expect(screen.getByRole('status').textContent).toBe('1 个失败')
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(injected.dismissSet).toHaveBeenCalledWith(SET)
    expect(injected.refreshSet).not.toHaveBeenCalled()
  })

  it('withdraws queued children only from the sets that have them', () => {
    const statuses: SessionStatusSnapshot = new Map([
      [A, { running: true, pendingInteraction: undefined, completionUnread: false }],
      [B, { running: true, pendingInteraction: undefined, completionUnread: false }],
    ])
    const sets = [
      tracked({ children: [{ index: 0, state: 'started', sessionId: A }, { index: 1, state: 'queued' }] }),
      tracked({ setId: SET2, lines: [], children: [{ index: 0, state: 'started', sessionId: B }] }),
    ]
    const { props, injected } = bench({ branching: { sets }, statuses })
    render(<RunningStrip {...props} />)
    expect(screen.getByRole('status').textContent).toBe('2 running · 1 queued')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel queued' }))
    expect(injected.cancelBranches.mock.calls).toEqual([[SET, undefined]])
  })

  it('shows a queued child of a lost set as not started, with no dot of activity', () => {
    const { props } = bench({ branching: { sets: [tracked({ lost: true, children: [{ index: 1, state: 'queued' }, { index: 2, state: 'failed', code: 'gateway/internal' }] })] } })
    render(<RunningStrip {...props} />)
    const strip = screen.getByRole('region', { name: 'Running branches' })
    expect(strip.querySelector('[data-loom-strip-item="not-started"]')?.textContent).toBe('Second ideanot started')
    expect(within(strip).queryByRole('button', { name: 'Cancel queued' })).toBeNull()
  })
})

function editBench(options: { opensTurn?: boolean; access?: boolean; hasAttachments?: boolean; start?: () => Promise<LoomOutcome> } = {}) {
  const startBranches = vi.fn(options.start ?? (async (): Promise<LoomOutcome> => ({ ok: true })))
  const props: EditBranchProps = {
    sessionId: ROOT,
    turn: 2,
    messageSeq: SessionSeq(12),
    text: 'Go with C',
    hasAttachments: options.hasAttachments ?? false,
    opensTurn: options.opensTurn ?? true,
    useAccess: () => options.access ?? true,
    startBranches,
    t: tEn,
  } as never
  return { props, startBranches }
}

describe('Edit & branch', () => {
  it('edits the prompt in a panel and branches with it, opening the new branch', async () => {
    const { props, startBranches } = editBench({ hasAttachments: true })
    render(<EditBranch {...props} />)
    const action = screen.getByRole('button', { name: 'Edit and branch' })
    fireEvent.click(action)
    const panel = screen.getByRole('dialog', { name: 'Edit turn 2 into a new branch' })
    expect(panel.textContent).toContain('Images and files stay attached')
    const editor = within(panel).getByRole('textbox', { name: 'Edited prompt' })
    expect(editor).toHaveProperty('value', 'Go with C')
    // The editor took focus itself, and the placed panel leaves it there.
    expect(document.activeElement).toBe(editor)
    fireEvent.change(editor, { target: { value: 'Go with D' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(startBranches).toHaveBeenCalledWith({ kind: 'edit', sessionId: ROOT, turn: 2, text: 'Go with D' }, { ownerSessionId: ROOT, openStarted: true })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(startBranches).toHaveBeenCalledOnce()
    await act(async () => {})
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(action)
  })

  it('refuses an empty prompt, reports a failure, restores the text on reopening, and cancels', async () => {
    const { props, startBranches } = editBench({ start: async () => ({ ok: false, failure: { code: 'remote-access/denied', unknownOutcome: false } }) })
    render(<EditBranch {...props} />)
    const action = screen.getByRole('button', { name: 'Edit and branch' })
    fireEvent.click(action)
    const editor = screen.getByRole('textbox', { name: 'Edited prompt' })
    fireEvent.change(editor, { target: { value: '  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Branch' }))
    expect(screen.getByRole('alert').textContent).toBe('Write a prompt to branch with')
    expect(startBranches).not.toHaveBeenCalled()
    fireEvent.change(editor, { target: { value: 'New' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Branch' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'You cannot branch this Session')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(action)
    fireEvent.click(action)
    expect(screen.getByRole('textbox')).toHaveProperty('value', 'Go with C')
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(action)
    fireEvent.click(action)
    fireEvent.click(action)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names the action in a tooltip on a hover device', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} })))
    render(<EditBranch {...editBench().props} />)
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Edit and branch' }))
    expect(document.body.textContent).toContain('Edit and branch')
  })

  it('renders nothing under a message that did not open its Turn or without access', () => {
    render(<EditBranch {...editBench({ opensTurn: false }).props} />)
    render(<EditBranch {...editBench({ access: false }).props} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
