// @vitest-environment jsdom
/** The fork band and the header variant chip name the cut, the parent, and the variants at the cut. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { KeyedSnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { createLoomFamilySources, type LoomFamilyState } from '../src/client/family.ts'
import { ForkBand, type ForkBandProps } from '../src/client/ForkBand.tsx'
import { en, zh } from '../src/client/locales.ts'
import { VariantChip, type VariantChipProps } from '../src/client/VariantChip.tsx'

/** ResizeObserver stand-in that records its targets and lets a spec report a resize. */
class ResizeObserverStub {
  targets: Element[] = []
  private readonly callback: () => void
  constructor(callback: () => void) {
    this.callback = callback
    observers.push(this)
  }
  observe(target: Element): void { this.targets.push(target) }
  unobserve(): void {}
  disconnect(): void { this.targets = [] }
  notify(): void { this.callback() }
}
let observers: ResizeObserverStub[] = []

beforeEach(() => {
  observers = []
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const ROOT = SessionId('root')
const A = SessionId('a')
const B = SessionId('b')
const C = SessionId('c')

function row(id: SessionId, title: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, displayTitle: title, running: false, blank: false, updatedAt: 1, retainedBy: {}, ...extra }
}

function fork(id: SessionId, title: string, cutSeq: number | undefined, createdAt: number, cutTurn?: number): SessionSummary {
  return row(id, title, {
    parentId: ROOT,
    projectionValues: cutSeq === undefined ? {} : {
      forkLineage: { parentSession: ROOT, cutSeq: SessionSeq(cutSeq), createdAt, ...cutTurn === undefined ? {} : { cutTurn } },
    },
  })
}

function listOf(rows: readonly SessionSummary[], ids: readonly SessionId[] = rows.map(item => item.id)): SessionListState {
  return { ids: [...ids], byId: Object.fromEntries(rows.map(item => [item.id, item])), phase: 'ready', projectionsBySession: {} }
}

const FAMILY = [row(ROOT, 'Failing delay test'), fork(A, 'Clamp final value', 10, 1, 1), fork(B, 'Downward-only jitter', 10, 2, 1), fork(C, 'Later cut', 20, 3, 2)]

/** Bind keyed family sources the way the renderer binds `keyedHooks`. */
function keyed<T>(source: (key: string) => ObservableSnapshot<T>): KeyedSnapshotSelectorHook<T> {
  const hook = (key: string, select?: (value: T | undefined) => unknown, equal?: (left: unknown, right: unknown) => boolean): unknown =>
    bindSnapshotSelector(source(key))(value => select === undefined ? value : select(value), equal)
  return hook as KeyedSnapshotSelectorHook<T>
}

function bench(options: { list?: SessionListState; sessionId?: SessionId; locale?: 'en' | 'zh' } = {}) {
  const sessions = createSnapshotStore<SessionListState>(options.list ?? listOf(FAMILY))
  const families = createLoomFamilySources({ sessions })
  const injected = { openSession: vi.fn(), refreshProjection: vi.fn() }
  const t = options.locale === 'zh' ? makeTranslate(zh, commonZh) : makeTranslate(en, commonEn)
  const shared = {
    sessionId: options.sessionId ?? B,
    useSessions: bindSnapshotSelector(sessions),
    useLoomFamily: keyed<LoomFamilyState>(key => families.source(key)),
    ...injected,
    t,
  }
  return { sessions, injected, shared }
}

function band(
  shared: ReturnType<typeof bench>['shared'],
  cut: { cutSeq: number; cutTurn?: number; inheritedTurn?: number } = { cutSeq: 10, cutTurn: 1, inheritedTurn: 1 },
) {
  const props = {
    ...shared,
    parentSession: ROOT,
    cutSeq: SessionSeq(cut.cutSeq),
    ...cut.cutTurn === undefined ? {} : { cutTurn: cut.cutTurn },
    ...cut.inheritedTurn === undefined ? {} : { inheritedTurn: cut.inheritedTurn },
    inheritedOpen: false,
  } as ForkBandProps
  return render(<ForkBand {...props} />)
}

describe('fork band', () => {
  it('names the parent and the cut, opens the parent, and lists the variants with the current one marked', () => {
    const { shared, injected } = bench()
    band(shared)
    const label = screen.getByRole('group', { name: 'Branched from Failing delay test after turn 1' })
    expect(label.textContent).toContain('Branched from')
    fireEvent.click(within(label).getByRole('button', { name: 'Open parent: Failing delay test' }))
    expect(injected.openSession).toHaveBeenCalledWith(ROOT)
    const variants = screen.getByRole('group', { name: 'Variants after turn 1' })
    const chips = within(variants).getAllByRole('button')
    expect(chips.map(chip => chip.getAttribute('aria-label'))).toEqual([
      'Variant 1 of 2: Clamp final value',
      'Variant 2 of 2: Downward-only jitter',
    ])
    expect(chips[1]?.getAttribute('aria-current')).toBe('true')
    expect(chips[0]?.getAttribute('aria-current')).toBeNull()
    fireEvent.click(chips[1]!)
    expect(injected.openSession).toHaveBeenCalledOnce()
    fireEvent.click(chips[0]!)
    expect(injected.openSession).toHaveBeenLastCalledWith(A)
    expect(injected.refreshProjection).not.toHaveBeenCalled()
  })

  it('scrolls a one-row chip strip so the current variant is in view, also after the band narrows', () => {
    // The strip ends at x=100; the current chip ends at `chipRight`.
    let chipRight = 80
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const right = this.getAttribute('aria-current') === 'true' ? chipRight : 100
      return { left: 0, right, top: 0, bottom: 0, width: right, height: 0, x: 0, y: 0, toJSON: () => ({}) }
    })
    try {
      const { shared, sessions } = bench()
      const { unmount } = band(shared)
      const group = screen.getByRole('group', { name: 'Variants after turn 1' })
      const strip = within(group).getAllByRole('button')[0]!.parentElement!
      const stripObservers = (): ResizeObserverStub[] => observers.filter(observer => observer.targets.includes(strip))
      // A current chip inside the strip leaves it where it is.
      expect(strip.scrollLeft).toBe(0)
      expect(stripObservers()).toHaveLength(1)
      chipRight = 160
      act(() => { stripObservers()[0]!.notify() })
      expect(strip.scrollLeft).toBe(60)
      // A list update with the same variants keeps where the reader scrolled the strip.
      strip.scrollLeft = 0
      act(() => { sessions.set(listOf(FAMILY)) })
      expect(strip.scrollLeft).toBe(0)
      expect(stripObservers()).toHaveLength(1)
      const observer = stripObservers()[0]!
      unmount()
      expect(observer.targets).toEqual([])
    } finally { rect.mockRestore() }
  })

  it('fades only an end of the chip strip that hides chips', () => {
    const { shared } = bench()
    band(shared)
    const strip = within(screen.getByRole('group', { name: 'Variants after turn 1' })).getAllByRole('button')[0]!.parentElement!
    expect(strip.hasAttribute('data-scroll-start')).toBe(false)
    expect(strip.hasAttribute('data-scroll-end')).toBe(false)
    const scrollWidth = vi.spyOn(strip, 'scrollWidth', 'get').mockReturnValue(300)
    const clientWidth = vi.spyOn(strip, 'clientWidth', 'get').mockReturnValue(100)
    strip.scrollLeft = 0
    fireEvent.scroll(strip)
    expect([strip.hasAttribute('data-scroll-start'), strip.hasAttribute('data-scroll-end')]).toEqual([false, true])
    strip.scrollLeft = 100
    fireEvent.scroll(strip)
    expect([strip.hasAttribute('data-scroll-start'), strip.hasAttribute('data-scroll-end')]).toEqual([true, true])
    strip.scrollLeft = 200
    fireEvent.scroll(strip)
    expect([strip.hasAttribute('data-scroll-start'), strip.hasAttribute('data-scroll-end')]).toEqual([true, false])
    scrollWidth.mockRestore()
    clientWidth.mockRestore()
  })

  it('shows a clipped chip title in full on hover', () => {
    vi.useFakeTimers()
    const width = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(500)
    try {
      const { shared } = bench()
      band(shared)
      fireEvent.mouseEnter(screen.getByRole('button', { name: 'Variant 1 of 2: Clamp final value' }))
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getAllByText('Clamp final value')).toHaveLength(2)
    } finally {
      width.mockRestore()
      vi.useRealTimers()
    }
  })

  it('names a cut inside a turn by the turn it interrupted', () => {
    const { shared } = bench()
    band(shared, { cutSeq: 10, cutTurn: 1, inheritedTurn: 2 })
    expect(screen.getByRole('group', { name: 'Branched from Failing delay test during turn 2' })).toBeTruthy()
  })

  it('renders nothing for a subagent child, whose cut is a delegation', () => {
    const delegated = listOf([...FAMILY.slice(0, 2), { ...FAMILY[2]!, origin: 'subagent' }, FAMILY[3]!])
    const { shared } = bench({ list: delegated })
    const { container } = band(shared)
    expect(container.textContent).toBe('')
    expect(container.querySelector('[data-loom-fork-band]')).toBeNull()
  })

  it('omits the chips for a lone variant and names a cut inside the first turn in Chinese', () => {
    const { shared } = bench({ locale: 'zh', sessionId: C })
    band(shared, { cutSeq: 20 })
    expect(screen.getByRole('group', { name: '分支自 Failing delay test，首轮结束之前' })).toBeTruthy()
    cleanup()
    band(bench({ locale: 'zh', sessionId: C }).shared, { cutSeq: 20, inheritedTurn: 1 })
    expect(screen.getByRole('group', { name: '分支自 Failing delay test，第 1 轮中' })).toBeTruthy()
    expect(screen.queryByRole('group', { name: /变体/u })).toBeNull()
  })

  it('reads an unlisted parent without a link and asks once for members whose lineage is missing', () => {
    const detached = listOf([fork(A, 'Untitled', undefined, 1), fork(B, 'Current', 10, 2, 1)])
    const { shared, injected, sessions } = bench({ list: detached })
    band(shared)
    expect(screen.getByRole('group', { name: 'Branched after turn 1' }).textContent).toContain('Branched')
    expect(screen.queryByRole('button', { name: /Open parent/u })).toBeNull()
    expect(injected.refreshProjection).not.toHaveBeenCalled()
    const withParent = listOf([row(ROOT, 'Root'), fork(A, 'Untitled', undefined, 1), fork(B, 'Current', 10, 2, 1)])
    act(() => { sessions.set(withParent) })
    act(() => { sessions.set({ ...withParent }) })
    expect(injected.refreshProjection.mock.calls).toEqual([[A]])
  })
})

describe('header variant chip', () => {
  function chip(shared: ReturnType<typeof bench>['shared']) {
    return render(<VariantChip {...shared as VariantChipProps} />)
  }

  it('uses the bottom sheet on phones and closes it after a sibling selection', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
    try {
      const { shared, injected } = bench()
      chip(shared)
      fireEvent.click(screen.getByRole('button', { name: /Switch variant/ }))
      const dialog = screen.getByRole('dialog')
      fireEvent.click(within(dialog).getByRole('button', { name: /Clamp final value/ }))
      expect(injected.openSession).toHaveBeenCalledWith(A)
      expect(screen.queryByRole('dialog')).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })

  it('shows "Variant k of N" with the cut and switches variants through its menu', () => {
    const { shared, injected } = bench()
    chip(shared)
    const trigger = screen.getByRole('button', { name: 'Variant 2 of 2, after turn 1. Switch variant' })
    expect(trigger.textContent).toBe('Variant 2 of 2 · after turn 1')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: /2\. Downward-only jitter/u }))
    expect(injected.openSession).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Switch variant/u }))
    fireEvent.click(screen.getByRole('menuitem', { name: /1\. Clamp final value/u }))
    expect(injected.openSession).toHaveBeenCalledWith(A)
    fireEvent.click(screen.getByRole('button', { name: /Switch variant/u }))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  })

  it('names a cut inside a turn from the parent outline, asking once for an outline that has not arrived', () => {
    const { shared, injected, sessions } = bench()
    chip(shared)
    expect(screen.getByRole('button', { name: 'Variant 2 of 2, after turn 1. Switch variant' })).toBeTruthy()
    expect(injected.refreshProjection.mock.calls).toEqual([[ROOT]])
    const outline = [{ turn: 1, seq: SessionSeq(0), prompt: '', response: '' }, { turn: 2, seq: SessionSeq(8), prompt: '', response: '' }]
    act(() => { sessions.set(listOf([row(ROOT, 'Failing delay test', { projectionValues: { turnOutline: outline } }), ...FAMILY.slice(1)])) })
    expect(screen.getByRole('button', { name: 'Variant 2 of 2, during turn 2. Switch variant' })).toBeTruthy()
    expect(injected.refreshProjection).toHaveBeenCalledOnce()
  })

  it('renders nothing for a root, a lone variant, or before the family arrives', () => {
    const { shared } = bench({ sessionId: ROOT })
    const { container } = chip(shared)
    expect(container.textContent).toBe('')
    cleanup()
    chip(bench({ sessionId: C }).shared)
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    const pending = bench({ list: { ...listOf(FAMILY), phase: 'pending' } })
    chip(pending.shared)
    expect(screen.queryByRole('button')).toBeNull()
  })

})
