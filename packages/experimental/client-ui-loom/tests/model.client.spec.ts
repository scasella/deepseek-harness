/** Fork facts, the family outline, the tab store, and the shared readings derive from the client Session list. */
import { describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { forkFamily, type LoomFamilyRow } from '@deepseek-ai/dsh-experimental-loom/family'
import type { LoomFamily } from '@deepseek-ai/dsh-experimental-loom/types'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionStatsFigures } from '@deepseek-ai/dsh-session-stats/client'
import { classes } from '../src/client/classes.ts'
import { compactTokens, cutReading, exactCount, plainPreview, plural, type LoomTranslate } from '../src/client/format.ts'
import {
  forkCutOf, inheritedCounts, inheritedSplitOf, membersWithoutLineage, openedTurnAt, ownCounts, ownTokens, projectionValuesOf,
  variantsOf,
} from '../src/client/lineage.ts'
import { en, zh } from '../src/client/locales.ts'
import { buildLoomTree, sessionRowId, type LoomPointRow, type LoomSessionRow } from '../src/client/tree.ts'
import { createLoomViewStore } from '../src/client/view-store.ts'

const ROOT = SessionId('root')
const A = SessionId('a')
const B = SessionId('b')
const C = SessionId('c')
const D = SessionId('d')
const tEn = makeTranslate(en, commonEn) as LoomTranslate
const tZh = makeTranslate(zh, commonZh) as LoomTranslate

function figures(turns: number, steps: number): SessionStatsFigures {
  return { turns, steps, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }
}

function usage(total: number) {
  return { uncachedInputTokens: total - 30, cacheReadTokens: 10, cacheWriteTokens: 10, outputTokens: 10 }
}

function row(id: SessionId, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, displayTitle: `title ${id}`, running: false, blank: false, updatedAt: 1, retainedBy: {}, ...extra }
}

function fork(id: SessionId, parent: SessionId, cutSeq: number, createdAt: number, cutTurn?: number): SessionSummary {
  return row(id, {
    parentId: parent,
    projectionValues: {
      forkLineage: { parentSession: parent, cutSeq: SessionSeq(cutSeq), createdAt, ...cutTurn === undefined ? {} : { cutTurn } },
      sessionStats: { ...figures(3, 9), fork: { own: figures(1, 4), inherited: figures(2, 5) } },
      tokenUsage: { ...usage(900), fork: { own: usage(600), inherited: usage(300) } },
    },
  })
}

function listOf(rows: readonly SessionSummary[], projections: SessionListState['projectionsBySession'] = {}): SessionListState {
  return { ids: rows.map(item => item.id), byId: Object.fromEntries(rows.map(item => [item.id, item])), phase: 'ready', projectionsBySession: projections }
}

function familyOf(list: SessionListState, focus: SessionId): LoomFamily {
  const rows: LoomFamilyRow[] = list.ids.map((id) => {
    const summary = list.byId[id]!
    const createdAt = summary.projectionValues?.forkLineage?.createdAt
    return {
      sessionId: id,
      ...summary.parentId === undefined ? {} : { forkParentId: summary.parentId },
      ...createdAt === undefined ? {} : { createdAt },
      updatedAt: summary.updatedAt,
      running: summary.running,
      blank: summary.blank,
    }
  })
  return forkFamily(rows, focus)!
}

/** Root with two variants after turn 1 (A, B), one sibling cut later (C), and a grandchild of A (D). */
function scenario() {
  const list = listOf([
    row(ROOT, { projectionValues: { sessionStats: figures(2, 7), tokenUsage: usage(400) } }),
    fork(A, ROOT, 10, 1, 1),
    fork(B, ROOT, 10, 2, 1),
    fork(C, ROOT, 20, 3),
    fork(D, A, 30, 4, 2),
  ])
  return { list, family: familyOf(list, B) }
}

describe('Loom fork facts', () => {
  it('reads explicit projection reads before list hints', () => {
    const explicit = listOf([row(ROOT)], { [ROOT]: { values: { tokenUsage: usage(50) }, state: 'ready', error: null } })
    expect(projectionValuesOf(explicit, ROOT)?.tokenUsage).toEqual(usage(50))
    expect(projectionValuesOf(listOf([row(ROOT, { projectionValues: { tokenUsage: usage(70) } })]), ROOT)?.tokenUsage).toEqual(usage(70))
    expect(projectionValuesOf(listOf([]), ROOT)).toBeUndefined()
  })

  it('reads a cut only for a fork with a parent and an inherited prefix', () => {
    const { list } = scenario()
    expect(forkCutOf(list, A)).toEqual({ parentId: ROOT, cutSeq: 10, cutTurn: 1 })
    expect(forkCutOf(list, C)).toEqual({ parentId: ROOT, cutSeq: 20 })
    expect(forkCutOf(list, ROOT)).toBeUndefined()
    const subagent = listOf([{ ...fork(A, ROOT, 10, 1), origin: 'subagent' }])
    expect(forkCutOf(subagent, A)).toBeUndefined()
    const seedless = listOf([row(A, { projectionValues: { forkLineage: { parentSession: ROOT, createdAt: 1 } } })])
    expect(forkCutOf(seedless, A)).toBeUndefined()
  })

  it('numbers variants by family order among siblings at the same cut only', () => {
    const { list, family } = scenario()
    expect(variantsOf(family, list, B)).toEqual({ parentId: ROOT, cutSeq: 10, cutTurn: 1, members: [A, B], index: 2 })
    expect(variantsOf(family, list, C)).toEqual({ parentId: ROOT, cutSeq: 20, members: [C], index: 1 })
    expect(variantsOf(family, list, ROOT)).toBeUndefined()
    const explicit = { parentId: ROOT, cutSeq: SessionSeq(10) }
    expect(variantsOf(family, list, A, explicit)).toEqual({ ...explicit, members: [A, B], index: 1 })
    const outside = SessionId('outside')
    expect(variantsOf(family, list, outside, explicit)).toEqual({ ...explicit, members: [outside], index: 1 })
  })

  it('lists members whose lineage has not arrived, never the root', () => {
    const { list, family } = scenario()
    expect(membersWithoutLineage(family, list)).toEqual([])
    const bare = listOf([row(ROOT), row(A, { parentId: ROOT })])
    expect(membersWithoutLineage(familyOf(bare, A), bare)).toEqual([A])
  })

  it('splits own from inherited history for every origin and reads the turn a seq falls in', () => {
    const subagent = { ...fork(A, ROOT, 10, 1, 1), origin: 'subagent' as const }
    expect(inheritedSplitOf(subagent.projectionValues)).toEqual({ cutSeq: 10, cutTurn: 1 })
    expect(inheritedSplitOf(fork(C, ROOT, 20, 1).projectionValues)).toEqual({ cutSeq: 20 })
    expect(inheritedSplitOf(row(ROOT).projectionValues)).toBeUndefined()
    expect(inheritedSplitOf({ forkLineage: { parentSession: ROOT, createdAt: 1 } })).toBeUndefined()
    const turnOutline = [
      { turn: 1, seq: SessionSeq(0), prompt: '', response: '' },
      { turn: 2, seq: SessionSeq(12), prompt: '', response: '' },
    ]
    expect(openedTurnAt({ turnOutline }, SessionSeq(11))).toBe(1)
    expect(openedTurnAt({ turnOutline }, SessionSeq(12))).toBe(2)
    expect(openedTurnAt({ turnOutline: [] }, SessionSeq(5))).toBeUndefined()
    expect(openedTurnAt(undefined, SessionSeq(5))).toBeUndefined()
  })

  it('reads own and inherited counts and own tokens', () => {
    const { list } = scenario()
    expect(ownCounts(projectionValuesOf(list, A))).toEqual({ turns: 1, steps: 4 })
    expect(ownCounts(projectionValuesOf(list, ROOT))).toEqual({ turns: 2, steps: 7 })
    expect(ownCounts(undefined)).toBeUndefined()
    expect(inheritedCounts(projectionValuesOf(list, A))).toEqual({ turns: 2, steps: 5 })
    expect(inheritedCounts(projectionValuesOf(list, ROOT))).toBeUndefined()
    expect(ownTokens(projectionValuesOf(list, A))).toBe(600)
    expect(ownTokens(projectionValuesOf(list, ROOT))).toBe(400)
    expect(ownTokens(undefined)).toBeUndefined()
  })
})

describe('Loom readings', () => {
  it('formats compact token counts in the Chat footer reading', () => {
    expect(compactTokens(517, tEn)).toBe('517')
    expect(compactTokens(12_240, tEn)).toBe('12.2K')
    expect(compactTokens(517_400, tEn)).toBe('517K')
    expect(compactTokens(1_230_000, tEn)).toBe('1.2M')
    expect(exactCount(36, tEn)).toBe('36')
    expect(exactCount(5_671, tEn)).toBe('5,671')
    expect(exactCount(1_234_567, tEn)).toBe('1,234,567')
    expect(compactTokens(250_000_000, tEn)).toBe('250M')
  })

  it('names a cut by the turn it falls in or after in both locales', () => {
    expect(cutReading(2, undefined, tEn)).toBe('after turn 2')
    expect(cutReading(2, 2, tEn)).toBe('after turn 2')
    expect(cutReading(2, 3, tEn)).toBe('during turn 3')
    expect(cutReading(undefined, 1, tEn)).toBe('during turn 1')
    expect(cutReading(undefined, undefined, tEn)).toBe('before turn 1 ended')
    expect(cutReading(2, undefined, tZh)).toBe('第 2 轮之后')
    expect(cutReading(2, 3, tZh)).toBe('第 3 轮中')
    expect(plural(1)).toBe('one')
    expect(plural(0)).toBe('other')
  })

  it('reduces Markdown previews to plain text on one line', () => {
    expect(plainPreview('## Cause `tinyq/retry.py:27-28` caps the *base* delay: `capped +')).toBe('Cause tinyq/retry.py:27-28 caps the base delay: capped +')
    expect(plainPreview('**Bold**, __strong__, _it_, ~~gone~~, [link](https://x), ![img](a.png)')).toBe('Bold, strong, it, gone, link, img')
    expect(plainPreview('- item\n> quote\n\n1. kept   as is')).toBe('item quote 1. kept as is')
    expect(plainPreview('the capped value:\n```python\ncapped = min(a, b)\n```\nDone')).toBe('the capped value: capped = min(a, b) Done')
    expect(plainPreview('value: ```python capped = min(a, b)')).toBe('value: capped = min(a, b)')
    expect(plainPreview('test_delays_never_exceed_max and a*b*c with `x_y_` kept')).toBe('test_delays_never_exceed_max and abc with x_y_ kept')
  })

  it('joins only present class names', () => {
    expect(classes('a', false, undefined, '', 'b')).toBe('a b')
  })

  it('keeps the dictionaries in step', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(en['view.loom']).toBe('Loom')
    expect(zh['view.loom']).toBe('织机')
  })
})

describe('Loom family outline', () => {
  const sessions = (rows: readonly (LoomSessionRow | LoomPointRow)[]) => rows.map(item => item.id)

  it('nests children under one branch point per cut with APG positions and the current path', () => {
    const { list, family } = scenario()
    const tree = buildLoomTree({
      family, list, currentSessionId: B, running: id => id === C ? true : undefined, collapsed: new Set(), marks: {},
    })
    expect(tree.sessionCount).toBe(5)
    expect(sessions(tree.rows)).toEqual(['s:root', 'p:root:10', 's:a', 'p:a:30', 's:d', 's:b', 'p:root:20', 's:c'])
    type Rows = [LoomSessionRow, LoomPointRow, LoomSessionRow, LoomPointRow, LoomSessionRow, LoomSessionRow, LoomPointRow, LoomSessionRow]
    const [root, after1, a, , d, b, cut20, c] = tree.rows as Rows
    expect(root).toMatchObject({ level: 1, posinset: 1, setsize: 1, expandable: true, expanded: true, onPath: true, turns: 2, steps: 7, tokens: 400, status: 'done', current: false, rails: [] })
    expect(root.parentRowId).toBeUndefined()
    expect(after1).toMatchObject({ kind: 'point', level: 2, parentRowId: 's:root', posinset: 1, setsize: 2, cutSeq: 10, cutTurn: 1, branchCount: 2, tokens: 1200, onPath: true, rails: [true] })
    expect(a).toMatchObject({ level: 3, posinset: 1, setsize: 2, expandable: true, onPath: false, title: 'title a', turns: 1, steps: 4, tokens: 600 })
    expect(d).toMatchObject({ level: 5, parentRowId: 'p:a:30', expandable: false, expanded: false, rails: [true, true, false, false] })
    expect(b).toMatchObject({ level: 3, posinset: 2, setsize: 2, onPath: true, current: true, rails: [true, false] })
    expect(cut20).toMatchObject({ posinset: 2, setsize: 2, cutSeq: 20, onPath: false, rails: [false] })
    expect(cut20.cutTurn).toBeUndefined()
    expect(c).toMatchObject({ status: 'running' })
  })

  it('hides collapsed rows and groups children whose cut has not arrived last', () => {
    const list = listOf([
      row(ROOT, { running: true }),
      row(A, { parentId: ROOT, blank: true, displayTitle: 'A' }),
      fork(B, ROOT, 5, 1, 1),
    ])
    const family = familyOf(list, A)
    const open = buildLoomTree({ family, list, currentSessionId: A, running: () => undefined, collapsed: new Set(), marks: {} })
    expect(sessions(open.rows)).toEqual(['s:root', 'p:root:5', 's:b', 'p:root:?', 's:a'])
    const unknown = open.rows[3] as LoomPointRow
    expect(unknown).toMatchObject({ branchCount: 1, onPath: true })
    expect(unknown.cutSeq).toBeUndefined()
    expect(unknown.tokens).toBeUndefined()
    expect(open.rows[0]).toMatchObject({ status: 'running' })
    expect(open.rows[4]).toMatchObject({ status: 'blank', title: 'A' })
    expect((open.rows[4] as LoomSessionRow).tokens).toBeUndefined()
    expect((open.rows[4] as LoomSessionRow).steps).toBeUndefined()
    const pointClosed = buildLoomTree({ family, list, currentSessionId: A, running: () => undefined, collapsed: new Set(['p:root:5']), marks: {} })
    expect(sessions(pointClosed.rows)).toEqual(['s:root', 'p:root:5', 'p:root:?', 's:a'])
    expect(pointClosed.rows[1]).toMatchObject({ expanded: false })
    const rootClosed = buildLoomTree({
      family, list, currentSessionId: A, running: () => undefined, collapsed: new Set([sessionRowId(ROOT)]), marks: {},
    })
    expect(sessions(rootClosed.rows)).toEqual(['s:root'])
    expect(rootClosed.rows[0]).toMatchObject({ expandable: true, expanded: false })
  })

  it('tells two cuts inside one parent turn apart by the turn they interrupted', () => {
    const turnOutline = [
      { turn: 1, seq: SessionSeq(0), prompt: '', response: '' },
      { turn: 2, seq: SessionSeq(10), prompt: '', response: '' },
    ]
    const list = listOf([
      row(ROOT, { projectionValues: { turnOutline } }),
      fork(A, ROOT, 12, 1, 1),
      fork(B, ROOT, 15, 2, 1),
      fork(C, ROOT, 8, 3, 1),
    ])
    const tree = buildLoomTree({
      family: familyOf(list, A), list, currentSessionId: A, running: () => undefined, collapsed: new Set(), marks: {},
    })
    const points = tree.rows.filter((item): item is LoomPointRow => item.kind === 'point')
    expect(points.map(point => [point.id, point.cutTurn, point.openedTurn])).toEqual([
      ['p:root:8', 1, 1], ['p:root:12', 1, 2], ['p:root:15', 1, 2],
    ])
  })

  it('reads a fork without own turns as not having run', () => {
    const list = listOf([row(ROOT), row(A, {
      parentId: ROOT,
      projectionValues: {
        forkLineage: { parentSession: ROOT, cutSeq: SessionSeq(5), createdAt: 1 },
        sessionStats: { ...figures(1, 2), fork: { own: figures(0, 0), inherited: figures(1, 2) } },
      },
    })])
    const tree = buildLoomTree({
      family: familyOf(list, A), list, currentSessionId: A, running: () => undefined, collapsed: new Set(), marks: {},
    })
    expect(tree.rows.at(-1)).toMatchObject({ sessionId: A, turns: 0, status: 'blank' })
  })

  it('orders the unknown cut last whatever order the family lists the children in', () => {
    const list = listOf([row(ROOT), row(A, { parentId: ROOT }), fork(B, ROOT, 5, 1, 1)])
    const family: LoomFamily = {
      rootId: familyOf(list, ROOT).rootId,
      focusId: familyOf(list, ROOT).focusId,
      nodes: [...familyOf(list, ROOT).nodes].sort((left, right) => left.sessionId === A ? -1 : right.sessionId === A ? 1 : 0),
    }
    expect(family.nodes.map(node => node.sessionId)).toEqual([A, ROOT, B])
    const tree = buildLoomTree({ family, list, currentSessionId: ROOT, running: () => undefined, collapsed: new Set(), marks: {} })
    expect(sessions(tree.rows)).toEqual(['s:root', 'p:root:5', 's:b', 'p:root:?', 's:a'])
  })

  it('falls back to the Session id for an unlisted title and renders nothing for an empty family', () => {
    const list = listOf([row(ROOT)])
    const family = familyOf(list, ROOT)
    const bare = { ...list, byId: {} }
    expect(buildLoomTree({ family, list: bare, currentSessionId: ROOT, running: () => false, collapsed: new Set(), marks: {} }).rows[0]).toMatchObject({ title: 'root' })
    const empty = buildLoomTree({
      family: { ...family, nodes: [] }, list, currentSessionId: ROOT, running: () => false, collapsed: new Set(), marks: {},
    })
    expect(empty.rows).toEqual([])
  })
})

describe('Loom view store', () => {
  it('selects a Session, toggles rows, and moves the tab stop', () => {
    const store = createLoomViewStore().create()
    expect(store.getSnapshot()).toMatchObject({ mode: 'read', point: null, picked: null, selected: null, collapsed: [], active: null })
    store.actions.selected(A)
    store.actions.toggled('s:root')
    store.actions.toggled('p:root:10')
    store.actions.activated('s:a')
    expect(store.getSnapshot()).toMatchObject({
      mode: 'read', point: null, picked: null, selected: A, collapsed: ['s:root', 'p:root:10'], active: 's:a',
    })
    store.actions.toggled('s:root')
    expect(store.getSnapshot().collapsed).toEqual(['p:root:10'])
  })

  it('switches mode, picks a branch, and closes the pick when it moves to another branch point', () => {
    const store = createLoomViewStore().create()
    store.actions.mode('compare')
    store.actions.picked(A)
    expect(store.getSnapshot()).toMatchObject({ mode: 'compare', picked: A, point: null })
    store.actions.pointed('p:root:10')
    expect(store.getSnapshot()).toMatchObject({ point: 'p:root:10', picked: null })
    store.actions.picked(A)
    store.actions.picked(null)
    expect(store.getSnapshot().picked).toBeNull()
    // Selecting another Session in the reading pane moves Compare to that Session's branch point.
    store.actions.pointed('p:root:10')
    store.actions.picked(A)
    store.actions.selected(B)
    expect(store.getSnapshot()).toMatchObject({ selected: B, point: null, picked: null })
  })
})
