/** Fork-family sources derive each family from the client Session list while observed and keep unchanged references. */
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { LoomFamily } from '@deepseek-ai/dsh-experimental-loom/types'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { createLoomFamilySources, type LoomFamilyState } from '../src/client/family.ts'

const ROOT = SessionId('root')
const A = SessionId('a')
const B = SessionId('b')

function row(id: SessionId, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, displayTitle: id, running: false, blank: false, updatedAt: 1, retainedBy: {}, ...extra }
}

/** A fork row whose list hint carries its header creation time. */
function fork(id: SessionId, parent: SessionId, createdAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  return row(id, {
    parentId: parent,
    projectionValues: { forkLineage: { parentSession: parent, cutSeq: SessionSeq(1), createdAt } },
    ...extra,
  })
}

function listState(rows: readonly SessionSummary[], phase: SessionListState['phase'] = 'ready'): SessionListState {
  return { ids: rows.map(item => item.id), byId: Object.fromEntries(rows.map(item => [item.id, item])), phase, projectionsBySession: {} }
}

function harness(initial: SessionListState = listState([row(ROOT), fork(A, ROOT, 10)])) {
  const sessions = createSnapshotStore(initial)
  const sources = createLoomFamilySources({ sessions })
  return { sessions, sources }
}

function ready(state: LoomFamilyState): LoomFamily {
  if (state.status !== 'ready') throw new Error(`expected a ready family, got ${state.status}`)
  return state.family
}

describe('Loom family sources', () => {
  it('keeps one source per Session and follows the list only while observed', () => {
    const { sources, sessions } = harness()
    const source = sources.source(A)
    expect(sources.source(A)).toBe(source)
    expect(source.getSnapshot()).toEqual({ status: 'loading' })
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    const second = source.subscribe(vi.fn())
    const family = ready(source.getSnapshot())
    expect(family).toEqual({
      rootId: 'root',
      focusId: 'a',
      nodes: [
        { id: 'root', sessionId: 'root', depth: 0, updatedAt: 1, running: false, blank: false },
        { id: 'a', sessionId: 'a', parentId: 'root', depth: 1, createdAt: 10, updatedAt: 1, running: false, blank: false },
      ],
    })
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
    unsubscribe()
    second()
    sessions.set(listState([row(ROOT), fork(A, ROOT, 10, { running: true })]))
    expect(source.getSnapshot()).toEqual({ status: 'ready', family })
    // The last unsubscribe dropped the source; a new lookup starts a fresh one.
    const fresh = sources.source(A)
    expect(fresh).not.toBe(source)
    expect(fresh.getSnapshot()).toEqual({ status: 'loading' })
    source.subscribe(vi.fn())
    expect(ready(source.getSnapshot()).nodes[1]?.running).toBe(true)
    sources.source(ROOT)
    sources.dispose()
    sessions.set(listState([row(ROOT), fork(A, ROOT, 10)]))
    expect(ready(source.getSnapshot()).nodes[1]?.running).toBe(true)
  })

  it('follows live status and recency, keeping every unchanged reference', () => {
    const { sources, sessions } = harness()
    const source = sources.source(A)
    const listener = vi.fn()
    source.subscribe(listener)
    const first = ready(source.getSnapshot())
    sessions.set(listState([row(ROOT), fork(A, ROOT, 10)]))
    expect(ready(source.getSnapshot())).toBe(first)
    sessions.set(listState([row(ROOT, { running: true, updatedAt: 5 }), fork(A, ROOT, 10)]))
    const second = ready(source.getSnapshot())
    expect(second.nodes.map(item => [item.running, item.updatedAt])).toEqual([[true, 5], [false, 1]])
    expect(second.nodes[1]).toBe(first.nodes[1])
    expect(listener).toHaveBeenCalledTimes(2)
    sessions.set(listState([row(ROOT), fork(A, ROOT, 10, { blank: true })], 'pending'))
    expect(ready(source.getSnapshot())).toBe(second)
  })

  it('stays loading on a pending list and keeps siblings in creation order while they run', () => {
    const { sources, sessions } = harness(listState([], 'pending'))
    const source = sources.source(ROOT)
    source.subscribe(vi.fn())
    expect(source.getSnapshot()).toEqual({ status: 'loading' })
    sessions.set(listState([row(ROOT), fork(B, ROOT, 10, { updatedAt: 1 }), fork(A, ROOT, 20, { updatedAt: 9, running: true })]))
    expect(ready(source.getSnapshot()).nodes.map(item => item.sessionId)).toEqual(['root', 'b', 'a'])
    sessions.set(listState([row(ROOT), fork(B, ROOT, 10, { updatedAt: 30, running: true }), fork(A, ROOT, 20, { updatedAt: 9 })]))
    expect(ready(source.getSnapshot()).nodes.map(item => item.sessionId)).toEqual(['root', 'b', 'a'])
  })

  it('adds a new fork of a member and drops a member that leaves the list', () => {
    const { sources, sessions } = harness()
    const source = sources.source(A)
    source.subscribe(vi.fn())
    const rootSource = sources.source(ROOT)
    rootSource.subscribe(vi.fn())
    sessions.set(listState([row(ROOT), fork(A, ROOT, 10), fork(B, A, 20)]))
    expect(ready(source.getSnapshot()).nodes.map(item => [item.sessionId, item.depth])).toEqual([['root', 0], ['a', 1], ['b', 2]])
    expect(ready(rootSource.getSnapshot()).nodes).toEqual(ready(source.getSnapshot()).nodes)
    sessions.set(listState([fork(A, ROOT, 10), fork(B, A, 20)]))
    expect(ready(source.getSnapshot()).rootId).toBe('a')
  })

  it('leaves subagent children and Host-unlisted rows out of the family', () => {
    const helper = SessionId('helper')
    const { sources } = harness({
      ...listState([row(ROOT), fork(A, ROOT, 10), row(helper, { parentId: A, origin: 'subagent' })]),
      ids: [ROOT, A, helper, SessionId('ghost')],
    })
    const source = sources.source(A)
    source.subscribe(vi.fn())
    expect(ready(source.getSnapshot()).nodes.map(item => item.sessionId)).toEqual(['root', 'a'])
  })

  it('reports a Session the list does not hold and recovers when it appears', () => {
    const { sources, sessions } = harness(listState([row(ROOT)]))
    const source = sources.source(A)
    source.subscribe(vi.fn())
    expect(source.getSnapshot()).toEqual({ status: 'unlisted' })
    sessions.set(listState([row(SessionId('other'))]))
    expect(source.getSnapshot()).toEqual({ status: 'unlisted' })
    sessions.set(listState([row(ROOT), fork(A, ROOT, 10)]))
    expect(ready(source.getSnapshot()).focusId).toBe('a')
  })
})
