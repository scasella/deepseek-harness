// @vitest-environment jsdom
/** Compare mode of the Loom tab: the outcome table, the picked branch's diff and actions, and the mode switch. */
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { KeyedSnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { LoomBranchingState, LoomOutcome, LoomValueOutcome } from '../src/client/branching.ts'
import { createLoomFamilySources, type LoomFamilyState } from '../src/client/family.ts'
import { en, zh } from '../src/client/locales.ts'
import { LoomView, type LoomViewProps } from '../src/client/LoomView.tsx'
import { createLoomReads, loomCompareKey } from '../src/client/reads.ts'
import type { LoomReadState } from '../src/client/read-sources.ts'
import type {
  LoomAdoptValue, LoomApplyValue, LoomCompareValue, LoomDiffValue, LoomDiscardValue,
} from '@deepseek-ai/dsh-experimental-loom/types'
import { createLoomViewStore } from '../src/client/view-store.ts'
import { compareRow, entry } from './fixtures.client.ts'

const ROOT = SessionId('root')
const A = SessionId('a')
const B = SessionId('b')
const C = SessionId('c')
const D = SessionId('d')

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

function summary(id: SessionId, title: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, displayTitle: title, running: false, blank: false, updatedAt: 1, retainedBy: {}, ...extra }
}

function fork(id: SessionId, title: string, cutSeq: number, createdAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  return summary(id, title, {
    parentId: ROOT,
    projectionValues: {
      forkLineage: { parentSession: ROOT, cutSeq: SessionSeq(cutSeq), createdAt, cutTurn: 1 },
      ...extra.projectionValues,
    },
    ...extra.running === undefined ? {} : { running: extra.running },
  })
}

const ROWS = [
  summary(ROOT, 'Failing delay test', { projectionValues: { turnOutline: [entry(1, 0), entry(2, 30)] } }),
  fork(A, 'Clamp final value', 10, 1),
  fork(B, 'Downward-only jitter', 10, 2),
  fork(C, 'Pre-scale the cap', 10, 3),
  fork(D, 'Later cut', 35, 4),
]

function listOf(rows: readonly SessionSummary[]): SessionListState {
  return { ids: rows.map(item => item.id), byId: Object.fromEntries(rows.map(item => [item.id, item])), phase: 'ready', projectionsBySession: {} }
}

const TESTS = { passed: 9, failed: 0, total: 9, ok: true, command: 'python -m unittest' }
const change = (path: string, insertions: number, deletions: number) => ({
  files: [{ path, insertions, deletions }, { path: 'tests/test_retry.py', insertions: 18, deletions: 0 }],
  insertions: insertions + 18,
  deletions,
  source: 'worktree' as const,
})

const COMPARE: LoomCompareValue = {
  parent: ROOT,
  cutSeq: SessionSeq(10),
  cutTurn: 1,
  rows: [
    compareRow('a', {
      title: 'Clamp final value',
      prompt: 'Go with A: clamp the final value.',
      isolation: 'worktree',
      tests: TESTS,
      diff: change('tinyq/retry.py', 11, 1),
      own: { steps: 6, inputTokens: 5_000, cachedTokens: 120_000, outputTokens: 2_000, usd: { amount: 0.0062805, label: 'list price' } },
      wallMs: 22_000,
    }),
    compareRow('b', {
      title: 'Downward-only jitter',
      prompt: 'Go with C: downward-only jitter.',
      isolation: 'worktree',
      running: true,
      mark: 'keep',
      own: { steps: 2, inputTokens: 1_000, cachedTokens: 0, outputTokens: 300, usd: { amount: 0.0004, label: 'list price' } },
    }),
    compareRow('c', {
      title: 'Pre-scale the cap',
      prompt: 'Go with F: pre-scale the cap.',
      adopted: true,
      tests: { passed: 5, failed: 2, total: 7, ok: false, command: 'pytest -q' },
      diff: { files: [], insertions: 0, deletions: 0, source: 'workspace-changes' },
      own: { steps: 11, inputTokens: 9_000, cachedTokens: 40_000, outputTokens: 6_000 },
      wallMs: 65_000,
    }),
  ],
}

const UNIFIED = [
  'diff --git a/tinyq/retry.py b/tinyq/retry.py',
  '--- a/tinyq/retry.py',
  '+++ b/tinyq/retry.py',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-yield capped + jitter',
  '+yield capped - jitter',
  '',
].join('\n')

function ok<V>(value: V): RemoteResult<V> {
  return { ok: true, value }
}

function refused(code: 'remote-access/denied'): RemoteResult<never> {
  return { ok: false, error: new RemoteError(code, code, { action: 'loom/compare', reason: 'no-allow' }) }
}

/** Bind keyed sources the way the renderer does: one hook per source object, so a render does not resubscribe. */
function keyed<T>(source: (key: string) => ObservableSnapshot<T>): KeyedSnapshotSelectorHook<T> {
  const hooks = new WeakMap<ObservableSnapshot<T>, ReturnType<typeof bindSnapshotSelector<T | undefined>>>()
  return ((key: string, select?: (value: T | undefined) => unknown, equal?: (left: unknown, right: unknown) => boolean): unknown => {
    const observable = source(key)
    let hook = hooks.get(observable)
    if (hook === undefined) {
      hook = bindSnapshotSelector<T | undefined>(observable)
      hooks.set(observable, hook)
    }
    return hook(value => select === undefined ? value : select(value), equal)
  }) as KeyedSnapshotSelectorHook<T>
}

/** A source that never leaves loading, for panes the specs do not read. */
const LOADING: ObservableSnapshot<{ readonly status: 'loading' }> = { subscribe: () => () => {}, getSnapshot: () => LOADING_STATE }
const LOADING_STATE = { status: 'loading' as const }

/** Let every pending read settle and its result render. */
const flush = async (): Promise<void> => {
  await act(async () => {
    for (let tick = 0; tick < 8; tick += 1) await Promise.resolve()
  })
}

function bench(options: {
  rows?: readonly SessionSummary[]
  sessionId?: SessionId
  locale?: 'en' | 'zh'
  compare?: (request: { sessionId: SessionId }) => Promise<RemoteResult<LoomCompareValue>>
  diff?: (request: { sessionId: SessionId; path?: string }) => Promise<RemoteResult<LoomDiffValue>>
  adopt?: () => Promise<LoomValueOutcome<LoomAdoptValue>>
  apply?: () => Promise<LoomValueOutcome<LoomApplyValue>>
  discard?: () => Promise<LoomValueOutcome<LoomDiscardValue>>
  branching?: LoomBranchingState
  mode?: 'read' | 'compare'
} = {}) {
  const sessions = createSnapshotStore<SessionListState>(listOf(options.rows ?? ROWS))
  const statuses = createSnapshotStore<SessionStatusSnapshot>(new Map())
  const branching = createSnapshotStore<LoomBranchingState>(options.branching ?? { sets: [], forms: {}, marks: {} })
  const families = createLoomFamilySources({ sessions })
  const compare = vi.fn(options.compare ?? (async () => ok(COMPARE)))
  const diff = vi.fn(options.diff ?? (async () => ok({ unified: UNIFIED, truncated: false })))
  const reads = createLoomReads({
    compare,
    diff,
    estimate: async () => ok({ priced: false, cacheShare: 0, basis: 'family' as const }),
  })
  const store = createLoomViewStore().create()
  if (options.mode !== 'read') store.actions.mode('compare')
  const injected = {
    openSession: vi.fn(),
    refreshProjection: vi.fn(),
    loadOlder: vi.fn(),
    completeViewRequest: vi.fn(),
    insetComposerStart: vi.fn(),
    openForm: vi.fn(),
    setMark: vi.fn(async (): Promise<LoomOutcome> => ({ ok: true })),
    refreshCompare: vi.fn((sessionId: SessionId) => { reads.compare.refresh(loomCompareKey(sessionId)) }),
    adoptBranch: vi.fn(options.adopt ?? (async () => ({ ok: true as const, value: { adopted: A, archived: [B, C] } }))),
    applyBranch: vi.fn(options.apply ?? (async () => ({ ok: true as const, value: { applied: [{ path: 'tinyq/retry.py' }, { path: 'tests/test_retry.py' }] } }))),
    discardBranch: vi.fn(options.discard ?? (async () => ({ ok: true as const, value: { worktreePath: '/w', branchName: 'loom/a' } }))),
    renderFactorySlot: vi.fn((): ReactNode => null),
  }
  const props: LoomViewProps = {
    sessionId: options.sessionId ?? B,
    inspectCall: undefined,
    viewRequest: null,
    openView: vi.fn(),
    useSessions: bindSnapshotSelector(sessions),
    useSessionStatus: bindSnapshotSelector(statuses),
    useLoomFamily: keyed<LoomFamilyState>(key => families.source(key)),
    useLoomReader: keyed(() => LOADING),
    useLoomRequest: keyed(() => LOADING),
    useLoomCompare: keyed<LoomReadState<LoomCompareValue>>(key => reads.compare.source(key)),
    useLoomDiff: keyed<LoomReadState<LoomDiffValue>>(key => reads.diff.source(key)),
    useStore: bindSnapshotSelector(store),
    useLoomBranching: bindSnapshotSelector(branching),
    actions: store.actions,
    t: options.locale === 'zh' ? makeTranslate(zh, commonZh) : makeTranslate(en, commonEn),
    ...injected,
  } as never
  const view = render(<LoomView {...props} />)
  return { view, store, sessions, statuses, branching, compare, diff, injected, reads }
}

function row(id: SessionId): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-loom-compare-row="${id}"]`)
  if (found === null) throw new Error(`no compare row ${id}`)
  return found
}

describe('mode switch', () => {
  it('shows the tree and reading pane in Read mode and the comparison in Compare, with the composer spanning the tab there', async () => {
    const { injected, store } = bench({ mode: 'read' })
    const tabs = screen.getByRole('tablist', { name: 'View mode' })
    expect(within(tabs).getByRole('tab', { name: 'Read' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tree', { name: 'Fork family' })).toBeTruthy()
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(within(tabs).getByRole('tab', { name: 'Read' }).id)
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Compare' }))
    await flush()
    expect(store.getSnapshot().mode).toBe('compare')
    expect(screen.queryByRole('tree')).toBeNull()
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(within(tabs).getByRole('tab', { name: 'Compare' }).id)
    expect(await screen.findByRole('table', { name: 'Branch comparison' })).toBeTruthy()
    expect(injected.insetComposerStart).toHaveBeenLastCalledWith(0)
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Read' }))
    expect(screen.getByRole('tree', { name: 'Fork family' })).toBeTruthy()
  })

  it('says the family is unavailable while Compare has none to compare', () => {
    bench({ rows: [] })
    expect(screen.getByRole('status').textContent).toBe('Fork family is unavailable')
  })
})

describe('Compare table', () => {
  it('lists each branch with its outcome, cost, time, and marks, groups no rows without a shared outcome, and ranks none', async () => {
    const { compare } = bench()
    await flush()
    expect(compare).toHaveBeenCalledWith({ sessionId: A })
    const table = screen.getByRole('table', { name: 'Branch comparison' })
    expect(within(table).getAllByRole('columnheader').map(header => header.textContent)).toEqual([
      'Select', 'Branch', 'Tests', 'Diff', 'Steps', 'Cost · list price', 'Wall', 'Marks',
    ])
    expect(screen.getByText('After turn 1 · Failing delay test · 3 branches')).toBeTruthy()
    expect(screen.getByText('Some branches ran in worktrees')).toBeTruthy()
    const a = within(row(A))
    expect(a.getByText('Clamp final value')).toBeTruthy()
    expect(a.getByText('Go with A: clamp the final value.')).toBeTruthy()
    expect(a.getByText('9 passed').closest('span')?.getAttribute('title')).toBe('From the output of: python -m unittest')
    expect(a.getByText('+29')).toBeTruthy()
    expect(a.getByText('−1')).toBeTruthy()
    expect(a.getByText('2 files')).toBeTruthy()
    expect(a.getByText('$0.006')).toBeTruthy()
    expect(a.getByText('22s')).toBeTruthy()
    expect(a.getByText('worktree')).toBeTruthy()
    const b = within(row(B))
    expect(b.getByText('running')).toBeTruthy()
    expect(b.getByText('no test run found')).toBeTruthy()
    expect(b.getAllByText('—')).toHaveLength(2)
    expect(b.getByRole('button', { name: 'Keep: Downward-only jitter' }).getAttribute('aria-pressed')).toBe('true')
    expect(b.getByRole('button', { name: 'Set aside: Downward-only jitter' }).getAttribute('aria-pressed')).toBe('false')
    const c = within(row(C))
    expect(c.getByText('adopted')).toBeTruthy()
    expect(c.getByText('2 of 7 failed')).toBeTruthy()
    expect(c.getByText('no changes')).toBeTruthy()
    expect(c.getByText('1m 5s')).toBeTruthy()
    expect(c.getByText('55K tok')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/best/iu)
    expect(screen.queryByText(/Same test results/u)).toBeNull()
  })

  it('notes the rows that report the same test outcome', async () => {
    const rows = COMPARE.rows.map(item => item.sessionId === C ? { ...item, tests: TESTS, diff: change('other.py', 1, 0) } : item)
    bench({ compare: async () => ok({ ...COMPARE, rows }), locale: 'zh' })
    await flush()
    expect(screen.getByText('Clamp final value 和 Pre-scale the cap 的测试结果相同，但改动不同。'.replace(' 和 ', '、'))).toBeTruthy()
    expect(within(row(A)).getByTitle('与其他分支的测试结果相同')).toBeTruthy()
  })

  it('says the changes were the same when rows with one outcome made the same change', async () => {
    const rows = COMPARE.rows.map(item => item.sessionId === C ? { ...item, tests: TESTS, diff: COMPARE.rows[0]!.diff! } : item)
    bench({ compare: async () => ok({ ...COMPARE, rows }) })
    await flush()
    expect(screen.getByText('Same test results for Clamp final value and Pre-scale the cap.')).toBeTruthy()
  })

  it('shows tokens without a price and the plain column name', async () => {
    const rows = COMPARE.rows.map(item => ({ ...item, own: { ...item.own, usd: undefined } }))
    bench({ compare: async () => ok({ ...COMPARE, rows: rows.map(({ own: { usd: _usd, ...own }, ...rest }) => ({ ...rest, own })) }) })
    await flush()
    expect(screen.getAllByRole('columnheader').map(header => header.textContent)).toContain('Own tokens')
    expect(within(row(A)).getByText('127K tok')).toBeTruthy()
  })

  it('names a branch that has no title by a placeholder', async () => {
    const rows = COMPARE.rows.map(item => item.sessionId === A ? { ...item, title: '' } : item)
    bench({ compare: async () => ok({ ...COMPARE, rows }) })
    await flush()
    expect(within(row(A)).getByText('Untitled branch')).toBeTruthy()
    expect(within(row(A)).getByRole('button', { name: 'Keep: Untitled branch' })).toBeTruthy()
    fireEvent.click(within(row(A)).getByRole('radio', { name: 'Untitled branch' }))
    expect(screen.getByRole('region', { name: 'Selected branch: Untitled branch' })).toBeTruthy()
  })

  it('says why there is nothing to compare, while it reads, and when the read fails', async () => {
    bench({ rows: [ROWS[0]!], sessionId: ROOT })
    expect(screen.getByText(/has no branches to compare yet/u)).toBeTruthy()
    cleanup()
    const pending = bench({ compare: () => new Promise(() => {}) })
    expect(screen.getByRole('status').textContent).toBe('Comparing branches…')
    pending.view.unmount()
    bench({ compare: async () => refused('remote-access/denied') })
    await flush()
    expect(screen.getByRole('alert').textContent).toBe('You cannot branch this Session')
    cleanup()
    bench({ compare: () => Promise.reject(new Error('unmounted')) })
    await flush()
    expect(screen.getByRole('alert').textContent).toBe('Loom is not available right now')
  })

  it('keeps the table and says it may be out of date when a later read fails', async () => {
    const results = [async () => ok(COMPARE), async () => refused('remote-access/denied')]
    const { reads } = bench({ compare: () => results.shift()!() })
    await flush()
    act(() => { reads.compare.refresh(loomCompareKey(A)) })
    await flush()
    expect(screen.getByText('The latest read failed; this may be out of date')).toBeTruthy()
    expect(screen.getByRole('table')).toBeTruthy()
  })

  it('reads again when a branch at the cut starts or ends, and not on the first render', async () => {
    const { compare, statuses } = bench()
    await flush()
    expect(compare).toHaveBeenCalledTimes(1)
    act(() => { statuses.set(new Map([[B, { running: true }]]) as never) })
    await flush()
    expect(compare).toHaveBeenCalledTimes(2)
    act(() => { statuses.set(new Map([[B, { running: true }]]) as never) })
    await flush()
    expect(compare).toHaveBeenCalledTimes(2)
  })

  it('asks for the projections of members whose lineage has not arrived', async () => {
    const rows = [ROWS[0]!, { ...ROWS[1]!, projectionValues: {} }, ROWS[2]!]
    const { injected } = bench({ rows })
    await flush()
    expect(injected.refreshProjection).toHaveBeenCalledWith(A)
  })

  it('toggles a mark from the table, preferring a mark in flight to the Host row and the projection to both', async () => {
    const { injected, branching, sessions } = bench()
    await flush()
    fireEvent.click(within(row(A)).getByRole('button', { name: 'Keep: Clamp final value' }))
    expect(injected.setMark).toHaveBeenLastCalledWith(A, 'keep')
    fireEvent.click(within(row(B)).getByRole('button', { name: 'Keep: Downward-only jitter' }))
    expect(injected.setMark).toHaveBeenLastCalledWith(B, null)
    fireEvent.click(within(row(B)).getByRole('button', { name: 'Set aside: Downward-only jitter' }))
    expect(injected.setMark).toHaveBeenLastCalledWith(B, 'set-aside')
    act(() => { branching.set({ sets: [], forms: {}, marks: { [A]: { status: 'saving', mark: 'set-aside' } } }) })
    expect(within(row(A)).getByRole('button', { name: 'Set aside: Clamp final value' }).getAttribute('aria-pressed')).toBe('true')
    act(() => {
      const list = sessions.getSnapshot()
      const listed = list.byId[B]!
      const projectionValues = { ...listed.projectionValues, loomMark: null }
      sessions.set({ ...list, byId: { ...list.byId, [B]: { ...listed, projectionValues } } })
    })
    expect(within(row(B)).getByRole('button', { name: 'Keep: Downward-only jitter' }).getAttribute('aria-pressed')).toBe('false')
    act(() => { branching.set({ sets: [], forms: {}, marks: { [A]: { status: 'failed', failure: { code: 'session/not-found', unknownOutcome: false } } } }) })
    expect(screen.getAllByRole('status').some(node => node.textContent === 'This Session was not found')).toBe(true)
  })
})

describe('branch point picker', () => {
  it('opens on the point of the selected Session, switches points, and reads that point’s siblings', async () => {
    const { compare, store } = bench()
    await flush()
    const button = screen.getByRole('button', { name: /Comparing After turn 1/u })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: /During turn 2 · Failing delay test · 1 branch/u }))
    await flush()
    expect(store.getSnapshot().point).toBe('p:root:35')
    expect(compare).toHaveBeenLastCalledWith({ sessionId: D })
    expect(screen.getByText('During turn 2 · Failing delay test · 1 branch')).toBeTruthy()
  })

  it('closes the picker without a choice', async () => {
    const { store } = bench()
    await flush()
    const button = screen.getByRole('button', { name: /Comparing After turn 1/u })
    fireEvent.click(button)
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(store.getSnapshot().point).toBeNull()
  })

  it('names the point plainly when the family has only one', async () => {
    bench({ rows: ROWS.slice(0, 4) })
    await flush()
    expect(screen.queryByRole('button', { name: /Comparing/u })).toBeNull()
    expect(screen.getByText('After turn 1 · Failing delay test · 3 branches')).toBeTruthy()
  })
})

describe('picked branch', () => {
  async function pick(id: SessionId, options: Parameters<typeof bench>[0] = {}) {
    const result = bench(options)
    await flush()
    fireEvent.click(within(row(id)).getByRole('radio', { name: COMPARE.rows.find(item => item.sessionId === id)!.title }))
    await flush()
    return result
  }

  it('expands the diff with one tab per file, and reads a file’s own diff when its tab is pressed', async () => {
    const { diff, store } = await pick(A)
    expect(store.getSnapshot().picked).toBe(A)
    expect(row(A).dataset.picked).toBe('true')
    const detail = screen.getByRole('region', { name: 'Selected branch: Clamp final value' })
    expect(diff).toHaveBeenCalledWith({ sessionId: A })
    expect(detail.textContent).toContain('yield capped - jitter')
    const files = within(detail).getByRole('group', { name: 'Files in the diff' })
    expect(within(files).getAllByRole('button').map(button => button.textContent)).toEqual([
      'All files', 'tinyq/retry.py+11−1', 'tests/test_retry.py+18',
    ])
    fireEvent.click(within(files).getByRole('button', { name: /tests\/test_retry\.py/u }))
    await flush()
    expect(diff).toHaveBeenLastCalledWith({ sessionId: A, path: 'tests/test_retry.py' })
    expect(within(files).getByRole('button', { name: /tests\/test_retry\.py/u }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(files).getByRole('button', { name: 'All files' }))
    expect(within(files).getByRole('button', { name: 'All files' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('says when a diff is loading, failed, empty, binary, or cut', async () => {
    const results: (() => Promise<RemoteResult<LoomDiffValue>>)[] = [
      () => new Promise(() => {}),
    ]
    const { view } = bench({ diff: () => results[0]!() })
    await flush()
    fireEvent.click(within(row(A)).getByRole('radio', { name: 'Clamp final value' }))
    expect(screen.getByText('Reading the diff…')).toBeTruthy()
    view.unmount()
    cleanup()
    const failed = bench({ diff: async () => refused('remote-access/denied') })
    await flush()
    fireEvent.click(within(row(A)).getByRole('radio', { name: 'Clamp final value' }))
    await flush()
    expect(screen.getByRole('alert').textContent).toBe('You cannot branch this Session')
    failed.view.unmount()
    cleanup()
    const nothing = bench({ diff: () => Promise.reject(new Error('unmounted')) })
    await flush()
    fireEvent.click(within(row(A)).getByRole('radio', { name: 'Clamp final value' }))
    await flush()
    expect(screen.getByRole('alert').textContent).toBe('Loom is not available right now')
    nothing.view.unmount()
    cleanup()
    bench({
      diff: async () => ok({
        unified: 'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n',
        truncated: true,
      }),
    })
    await flush()
    fireEvent.click(within(row(A)).getByRole('radio', { name: 'Clamp final value' }))
    await flush()
    const text = screen.getByRole('region', { name: 'Selected branch: Clamp final value' }).textContent
    expect(text).toContain('This branch has no text changes')
    expect(text).toContain('Binary files not shown: logo.png')
    expect(text).toContain('The Host cut this diff; open the branch for the rest')
  })

  it('folds the middle of a long diff and offers the rest', async () => {
    const lines = Array.from({ length: 60 }, (_unused, index) => `+line ${String(index)}`)
    const unified = ['diff --git a/big.py b/big.py', '--- a/big.py', '+++ b/big.py', '@@ -0,0 +1,60 @@', ...lines, ''].join('\n')
    await pick(A, { diff: async () => ok({ unified, truncated: false }) })
    const expand = screen.getByRole('button', { name: 'Expand the other 21 diff lines' })
    expect(expand.textContent).toContain('… 21 more lines')
    fireEvent.click(expand)
    expect(screen.getByRole('button', { name: 'Collapse the diff' })).toBeTruthy()
  })

  it('adopts the branch, says how many siblings the Host archived, and reads the comparison again', async () => {
    const { injected, compare } = await pick(A)
    const detail = within(screen.getByRole('region', { name: 'Selected branch: Clamp final value' }))
    expect(detail.getByText('Makes it the main line; the other 2 are archived, never deleted.')).toBeTruthy()
    fireEvent.click(detail.getByRole('button', { name: 'Adopt' }))
    await flush()
    expect(injected.adoptBranch).toHaveBeenCalledWith(A)
    expect(screen.getByRole('status', { name: '' }).textContent).toContain('Adopted. 2 other branches archived, never deleted.')
    expect(compare).toHaveBeenCalledTimes(2)
  })

  it('reports an adoption of one archived sibling and of none, and a refused adoption', async () => {
    const results: LoomValueOutcome<LoomAdoptValue>[] = [
      { ok: true, value: { adopted: A, archived: [B] } },
      { ok: true, value: { adopted: A, archived: [] } },
      { ok: false, failure: { code: 'remote-access/denied', unknownOutcome: false } },
    ]
    await pick(A, { adopt: async () => results.shift()! })
    const adopt = (): HTMLElement => screen.getByRole('button', { name: 'Adopt' })
    fireEvent.click(adopt())
    await flush()
    expect(screen.getByText('Adopted. 1 other branch archived, never deleted.')).toBeTruthy()
    fireEvent.click(adopt())
    await flush()
    expect(screen.getByText('Adopted.')).toBeTruthy()
    fireEvent.click(adopt())
    await flush()
    expect(screen.getByRole('alert').textContent).toBe('You cannot branch this Session')
  })

  it('offers an adopted branch no second adoption, and a lone branch no archive promise', async () => {
    await pick(C)
    expect(screen.getByRole('button', { name: 'Adopted' })).toHaveProperty('disabled', true)
    cleanup()
    const lone = { ...COMPARE, rows: [COMPARE.rows[0]!] }
    bench({ compare: async () => ok(lone) })
    await flush()
    fireEvent.click(within(row(A)).getByRole('radio', { name: 'Clamp final value' }))
    expect(screen.getByText('Makes it the main line.')).toBeTruthy()
  })

  it('applies a worktree change only after a confirmation that names the files, then reads the comparison again', async () => {
    const { injected, compare } = await pick(A)
    const detail = screen.getByRole('region', { name: 'Selected branch: Clamp final value' })
    expect(within(detail).getByText('2 files from this worktree')).toBeTruthy()
    const apply = within(detail).getByRole('button', { name: 'Apply diff to folder' })
    fireEvent.click(apply)
    const confirm = within(detail).getByRole('group', { name: 'Confirm applying the diff' })
    expect(confirm.textContent).toContain('Write 2 files into the source folder, then remove this worktree?')
    expect(within(confirm).getAllByRole('listitem').map(item => item.textContent)).toEqual(['tinyq/retry.py', 'tests/test_retry.py'])
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(injected.applyBranch).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(within(detail).queryByRole('group', { name: 'Confirm applying the diff' })).toBeNull()
    expect(document.activeElement).toBe(apply)
    fireEvent.click(apply)
    fireEvent.keyDown(within(detail).getByRole('group', { name: 'Confirm applying the diff' }), { key: 'a' })
    fireEvent.keyDown(within(detail).getByRole('group', { name: 'Confirm applying the diff' }), { key: 'Escape' })
    expect(within(detail).queryByRole('group', { name: 'Confirm applying the diff' })).toBeNull()
    fireEvent.click(apply)
    fireEvent.click(within(detail).getByRole('button', { name: 'Apply' }))
    await flush()
    expect(injected.applyBranch).toHaveBeenCalledWith(A)
    expect(screen.queryByRole('button', { name: 'Discard worktree' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Apply diff to folder' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(detail).getByText('Applied 2 files to the folder. The worktree was removed.')).toBeTruthy()
    expect(compare).toHaveBeenCalledTimes(2)
  })

  it('names the paths a dirty or conflicting folder refuses, and a single applied file', async () => {
    const results: LoomValueOutcome<LoomApplyValue>[] = [
      { ok: false, failure: { code: 'loom/apply-dirty', paths: ['a.py'], unknownOutcome: false } },
      { ok: false, failure: { code: 'loom/apply-conflict', paths: ['b.py', 'c.py'], unknownOutcome: false } },
      { ok: true, value: { applied: [{ path: 'a.py' }] } },
    ]
    await pick(A, { apply: async () => results.shift()! })
    for (const text of [
      'The source folder has uncommitted changes in a.py; nothing was applied',
      'This change conflicts with the source folder in b.py, c.py; nothing was applied',
      'Applied 1 file to the folder. The worktree was removed.',
    ]) {
      fireEvent.click(screen.getByRole('button', { name: 'Apply diff to folder' }))
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
      await flush()
      expect(screen.getByText(text)).toBeTruthy()
    }
  })

  it('confirms before discarding a worktree, and says so when it is gone', async () => {
    const { injected } = await pick(A)
    const discard = screen.getByRole('button', { name: 'Discard worktree' })
    fireEvent.click(discard)
    const confirm = screen.getByRole('group', { name: 'Confirm discarding the worktree' })
    expect(confirm.textContent).toContain('Discard this worktree? Changes not applied to the folder are lost; the Session and its log stay.')
    fireEvent.keyDown(confirm, { key: 'a' })
    expect(screen.getByRole('group', { name: 'Confirm discarding the worktree' })).toBeTruthy()
    fireEvent.keyDown(confirm, { key: 'Escape' })
    expect(document.activeElement).toBe(discard)
    fireEvent.click(discard)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await flush()
    expect(injected.discardBranch).toHaveBeenCalledWith(A)
    expect(screen.getByText('Worktree discarded.')).toBeTruthy()
  })

  it('uses singular copy when adoption archives one sibling', async () => {
    await pick(A, { compare: async () => ok({ ...COMPARE, rows: COMPARE.rows.slice(0, 2) }) })
    expect(screen.getByText('Makes it the main line; the other branch is archived, never deleted.')).toBeTruthy()
  })

  it('offers a shared-folder branch no apply or discard, and a running branch neither until it ends', async () => {
    await pick(C)
    expect(screen.queryByRole('button', { name: 'Apply diff to folder' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Discard worktree' })).toBeNull()
    expect(screen.getByText(/worked in the shared folder/u)).toBeTruthy()
    cleanup()
    await pick(B)
    expect(screen.getByRole('button', { name: 'Apply diff to folder' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Discard worktree' })).toHaveProperty('disabled', true)
    expect(screen.getByText('Wait for this branch to finish before applying or discarding')).toBeTruthy()
  })

  it('has nothing to apply for a worktree branch without changes', async () => {
    const rows = COMPARE.rows.map(item => item.sessionId === A ? { ...item, diff: { files: [], insertions: 0, deletions: 0, source: 'worktree' as const } } : item)
    await pick(A, { compare: async () => ok({ ...COMPARE, rows }) })
    expect(screen.getByRole('button', { name: 'Apply diff to folder' })).toHaveProperty('disabled', true)
    expect(screen.getByText('No changes to apply')).toBeTruthy()
  })

  it('opens the branch in Chat, and closes the detail when the point changes', async () => {
    const { injected, store } = await pick(A)
    fireEvent.click(screen.getByRole('button', { name: 'Continue here' }))
    expect(injected.openSession).toHaveBeenCalledWith(A)
    act(() => { store.actions.pointed('p:root:35') })
    expect(store.getSnapshot().picked).toBeNull()
  })

  it('reads in Chinese', async () => {
    await pick(A, { locale: 'zh' })
    expect(screen.getByRole('button', { name: '采用' })).toBeTruthy()
    expect(screen.getByText('在对话中打开此分支。')).toBeTruthy()
  })
})

describe('tree and reading pane', () => {
  it('mark an adopted branch', () => {
    const rows = ROWS.map(item => item.id === A
      ? { ...item, projectionValues: { ...item.projectionValues, loomBranch: { setId: 's' as never, kind: 'steer' as const, index: 0, createdAt: 1, adopted: true as const } } }
      : item)
    bench({ rows, mode: 'read', sessionId: A })
    expect(screen.getAllByRole('treeitem').some(node => /adopted$/u.test(node.getAttribute('aria-label') ?? ''))).toBe(true)
    expect(within(screen.getByRole('article')).getByText('Adopted as the main line')).toBeTruthy()
  })
})
