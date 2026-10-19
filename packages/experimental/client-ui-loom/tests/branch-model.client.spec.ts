/** Pure S2 readings: the running strip, variant tallies, the route list, marks, and the copy of routes and failures. */
import { describe, expect, it, vi } from 'vitest'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionStatus } from '@deepseek-ai/dsh-client-ui-session/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LoomSetId } from '@deepseek-ai/dsh-experimental-loom/types'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { LoomTrackedSet } from '../src/client/branching.ts'
import { duplicateRows } from '../src/client/BranchForm.tsx'
import {
  cachePercent, durationText, failureText, isolationReasonText, listText, pathsText, pointReading, rangeText, routeLabel, routeText,
  rowsText, usdText,
} from '../src/client/format.ts'
import { branchOf, lastInheritedTurnOf, markOf } from '../src/client/lineage.ts'
import { createLoomRoutes, inheritedRoute, type LoomRouteOption } from '../src/client/routes.ts'
import { stripOf, type LoomStripInput } from '../src/client/strip.ts'
import { variantTallies } from '../src/client/tallies.ts'
import { buildLoomTree, type LoomPointRow, type LoomSessionRow } from '../src/client/tree.ts'
import { entry, familyIn, listOf, ROOT, SET, SET2, tEn, tZh, type Member } from './fixtures.client.ts'

const A = SessionId('a')
const B = SessionId('b')
const C = SessionId('c')

function status(running: boolean, pending = false): SessionStatus {
  return { running, pendingInteraction: pending ? ({ kind: 'approval' } as never) : undefined, completionUnread: false }
}

function tracked(extra: Partial<LoomTrackedSet> = {}): LoomTrackedSet {
  return {
    setId: SET, sourceSessionId: ROOT, ownerSessionId: ROOT, kind: 'steer', lines: ['first', 'second', 'third', 'fourth'], lost: false, reads: 0,
    children: [
      { index: 0, state: 'started', sessionId: A },
      { index: 1, state: 'queued' },
      { index: 2, state: 'failed', code: 'gateway/internal' },
      { index: 3, state: 'cancelled' },
    ],
    ...extra,
  }
}

const MEMBERS: readonly Member[] = [
  { id: 'root' },
  { id: 'a', parent: 'root', cutSeq: 10, cutTurn: 1, createdAt: 1, branch: { setId: SET, kind: 'steer', index: 0 } },
  { id: 'b', parent: 'root', cutSeq: 10, cutTurn: 1, createdAt: 2, branch: { setId: SET, kind: 'steer', index: 1 } },
  { id: 'c', parent: 'root', cutSeq: 10, cutTurn: 1, createdAt: 3, branch: { setId: SET2, kind: 'regenerate', index: 0 } },
  { id: 'd', parent: 'a', cutSeq: 20, cutTurn: 2, createdAt: 4, branch: { setId: brandString<LoomSetId>('set-3'), kind: 'regenerate', index: 0 } },
  { id: 'e', parent: 'root', cutSeq: 10, notBranch: true },
]

function input(extra: Partial<LoomStripInput> = {}): LoomStripInput {
  const list = listOf(MEMBERS)
  return { sessionId: ROOT, sets: [tracked()], family: familyIn(list, 'root'), list, statuses: new Map(), ...extra }
}

describe('running strip', () => {
  it('lists each child of a followed set by state and turns a queued child into the Session the family lists', () => {
    const strip = stripOf(input({ statuses: new Map([[A, status(true)], [B, status(false, true)]]) }))
    expect(strip.sets).toEqual([{
      setId: SET,
      active: true,
      items: [
        { setId: SET, index: 0, line: 'first', sessionId: A, status: 'running' },
        { setId: SET, index: 1, line: 'second', sessionId: B, status: 'approval' },
        { setId: SET, index: 2, line: 'third', status: 'failed', code: 'gateway/internal' },
      ],
      refreshKey: '0:running,1:approval,2:failed',
    }])
    expect(strip.counts).toEqual({ running: 1, queued: 0, approval: 1, failed: 1 })
  })

  it('shows queued children by line, as not started once the set is lost, and reads list running state without live status', () => {
    const list = listOf(MEMBERS.filter(member => member.id !== 'b').map(member => member.id === 'a' ? { ...member, running: true } : member))
    const strip = stripOf(input({ list, family: familyIn(list, 'root') }))
    expect(strip.sets[0]?.items.map(item => item.status)).toEqual(['running', 'queued', 'failed'])
    expect(strip.counts.queued).toBe(1)
    const lost = stripOf(input({ list, family: familyIn(list, 'root'), sets: [tracked({ lost: true })] }))
    expect(lost.sets[0]?.items[1]).toEqual({ setId: SET, index: 1, line: 'second', status: 'not-started' })
    expect(lost.sets[0]?.refreshKey).toBeUndefined()
    const unlisted = stripOf(input({ sets: [tracked({ setId: brandString<LoomSetId>('set-9'), lines: [], children: [{ index: 0, state: 'queued' }] })] }))
    expect(unlisted.sets[0]?.items).toEqual([{ setId: 'set-9', index: 0, status: 'queued' }])
    const failedStep = stripOf(input({ sets: [tracked({ children: [{ index: 0, state: 'failed', sessionId: A, code: 'gateway/internal' }] })] }))
    expect(failedStep.sets[0]?.items[0]).toEqual({ setId: SET, index: 0, line: 'first', sessionId: A, status: 'failed', code: 'gateway/internal' })
  })

  it('asks for a read after each status read while a set waits and none of its children runs or needs approval', () => {
    const list = listOf(MEMBERS.filter(member => member.id !== 'b'))
    const waiting = (extra: Partial<LoomTrackedSet>, statuses = new Map<SessionId, SessionStatus>()) =>
      stripOf(input({ list, family: familyIn(list, 'root'), statuses, sets: [tracked({ children: [{ index: 0, state: 'started', sessionId: A }, { index: 1, state: 'queued' }], ...extra })] })).sets[0]
    expect(waiting({ reads: 3 })).toMatchObject({ refreshKey: '0:done,1:queued', pollKey: 'set-1#3' })
    expect(waiting({ reads: 4 })?.pollKey).toBe('set-1#4')
    expect(waiting({}, new Map([[A, status(true)]]))?.pollKey).toBeUndefined()
    expect(waiting({}, new Map([[A, status(false, true)]]))?.pollKey).toBeUndefined()
    expect(waiting({ lost: true })?.pollKey).toBeUndefined()
    expect(waiting({ children: [{ index: 0, state: 'started', sessionId: A }, { index: 1, state: 'failed', code: 'session/model-unavailable' }] })?.pollKey).toBeUndefined()
  })

  it('keeps a finished set with a failure until dismissed and hides a finished set without one', () => {
    const done = stripOf(input({ sets: [tracked({ children: [{ index: 0, state: 'started', sessionId: A }, { index: 2, state: 'failed', code: 'session/not-found' }] })] }))
    expect(done.sets).toEqual([expect.objectContaining({ active: false })])
    expect(done.sets[0]?.items.map(item => item.status)).toEqual(['done', 'done', 'failed'])
    const quiet = stripOf(input({ sets: [tracked({ children: [{ index: 0, state: 'started', sessionId: A }], lines: [] })] }))
    expect(quiet.sets).toEqual([])
  })

  it('follows sets the Session owns for another source, ignores other sets, and reads children from the family alone', () => {
    const owned = tracked({ sourceSessionId: C, ownerSessionId: ROOT, setId: SET2, children: [], lines: [] })
    const foreign = tracked({ sourceSessionId: C, ownerSessionId: C })
    const strip = stripOf(input({ sets: [owned, foreign], statuses: new Map([[C, status(true)]]) }))
    expect(strip.sets.map(set => set.setId)).toEqual([SET2])
    expect(strip.sets[0]?.items).toEqual([{ setId: SET2, index: 0, sessionId: C, status: 'running' }])
  })

  it('names running sets of the Session’s own children that the browser does not follow', () => {
    const running = new Map([[C, status(true)], [SessionId('d'), status(true)]])
    expect(stripOf(input({ sets: [], statuses: running })).untracked).toEqual([{ setId: SET2, sourceSessionId: ROOT }])
    expect(stripOf(input({ sets: [], statuses: new Map() })).untracked).toEqual([])
    expect(stripOf(input({ sets: [], sessionId: A, statuses: running })).untracked).toEqual([{ setId: 'set-3', sourceSessionId: A }])
    expect(stripOf(input({ sets: [], sessionId: B, statuses: running })).untracked).toEqual([])
    expect(stripOf(input({ sets: [], family: undefined })).sets).toEqual([])
  })
})

describe('variant tallies', () => {
  it('tallies each line of a variants set by samples and marks, in line order, ignoring grandchildren and other kinds', () => {
    const members: Member[] = [
      { id: 'root', outline: [entry(1, 0), entry(2, 12)] },
      { id: 'v1', parent: 'root', cutSeq: 10, cutTurn: 1, branch: { setId: SET, kind: 'variants', index: 2, variantKey: 'k2' }, mark: 'keep' },
      { id: 'v2', parent: 'root', cutSeq: 10, cutTurn: 1, branch: { setId: SET, kind: 'variants', index: 0, variantKey: 'k1' }, outline: [entry(1, 0), entry(2, 11, 'Line one')] },
      { id: 'v3', parent: 'root', cutSeq: 10, cutTurn: 1, branch: { setId: SET, kind: 'variants', index: 1, variantKey: 'k1' }, mark: 'set-aside', outline: [entry(2, 11, 'Other')] },
      { id: 'v4', parent: 'root', cutSeq: 10, cutTurn: 1, branch: { setId: SET, kind: 'variants', index: 3, variantKey: 'k2' } },
      { id: 'v5', parent: 'root', cutSeq: 10, cutTurn: 1, branch: { setId: SET2, kind: 'variants', index: 0, variantKey: 'k3' } },
      { id: 's1', parent: 'root', cutSeq: 10, cutTurn: 1, branch: { setId: SET2, kind: 'steer', index: 0 } },
      { id: 'g1', parent: 'v1', cutSeq: 30, branch: { setId: SET, kind: 'variants', index: 0, variantKey: 'k1' } },
      { id: 'm1', parent: 'root', cutSeq: 40 },
    ]
    const list = listOf(members)
    const tallies = variantTallies(familyIn(list, 'root'), list, { [SessionId('v4')]: { status: 'saving', mark: 'keep' } })
    expect(tallies).toEqual([
      {
        pointId: 'p:root:10', cutSeq: 10, cutTurn: 1, openedTurn: 1,
        sets: [
          {
            setId: SET,
            lines: [
              { variantKey: 'k1', position: 1, prompt: 'Line one', samples: 2, kept: 0, setAside: 1 },
              { variantKey: 'k2', position: 2, prompt: '', samples: 2, kept: 2, setAside: 0 },
            ],
          },
          { setId: SET2, lines: [{ variantKey: 'k3', position: 1, prompt: '', samples: 1, kept: 0, setAside: 0 }] },
        ],
      },
      {
        pointId: 'p:v1:30', cutSeq: 30,
        sets: [{ setId: SET, lines: [{ variantKey: 'k1', position: 1, prompt: '', samples: 1, kept: 0, setAside: 0 }] }],
      },
    ])
  })
})

describe('route list', () => {
  const catalog: ModelCatalog = {
    default: { provider: 'p', model: 'm' },
    routableProviders: ['p'],
    groups: [
      { id: 'p', name: 'P', models: [{ id: 'm', name: 'M', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } }] },
      { id: 'q', name: 'Q', models: [{ id: 'n', name: 'N' }] },
    ],
    failures: [],
  }

  it('stays unavailable until attached, loads once, retries after a failure, and detaches', async () => {
    const routes = createLoomRoutes()
    routes.load()
    expect(routes.state.getSnapshot()).toEqual({ status: 'unavailable' })
    const results: (() => Promise<RemoteResult<ModelCatalog>>)[] = [
      async () => ({ ok: false, error: new RemoteError('gateway/internal', 'x', {}) }),
      () => Promise.reject(new Error('unmounted')),
      async () => ({ ok: true, value: catalog }),
    ]
    const read = vi.fn(() => results.shift()!())
    const detach = routes.attach(read)
    expect(routes.state.getSnapshot()).toEqual({ status: 'idle' })
    routes.load()
    routes.load()
    expect(read).toHaveBeenCalledOnce()
    await vi.waitFor(() => { expect(routes.state.getSnapshot()).toEqual({ status: 'failed' }) })
    routes.load()
    await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(routes.state.getSnapshot()).toEqual({ status: 'failed' }) })
    routes.load()
    await vi.waitFor(() => { expect(routes.state.getSnapshot().status).toBe('ready') })
    expect(routes.state.getSnapshot()).toEqual({ status: 'ready', options: [{ selection: { provider: 'p', model: 'm' }, providerName: 'P', modelName: 'M', efforts: [{ id: 'high', name: 'High' }] }] })
    routes.load()
    expect(read).toHaveBeenCalledTimes(3)
    detach()
    expect(routes.state.getSnapshot()).toEqual({ status: 'unavailable' })
  })

  it('drops a result that arrives after its reader detached', async () => {
    const routes = createLoomRoutes()
    let settle!: (value: RemoteResult<ModelCatalog>) => void
    let fail!: (error: unknown) => void
    const pending = [
      new Promise<RemoteResult<ModelCatalog>>((resolve) => { settle = resolve }),
      new Promise<RemoteResult<ModelCatalog>>((_resolve, reject) => { fail = reject }),
    ]
    const read = vi.fn(() => pending.shift()!)
    const detach = routes.attach(read)
    routes.load()
    detach()
    settle({ ok: true, value: catalog })
    const again = routes.attach(read)
    routes.load()
    again()
    fail(new Error('late'))
    await Promise.resolve()
    await Promise.resolve()
    expect(routes.state.getSnapshot()).toEqual({ status: 'unavailable' })
  })
})

describe('marks, routes, and failures', () => {
  it('reads branch membership, the last inherited turn, and the shown mark', () => {
    const list = listOf([...MEMBERS, { id: 'z', parent: 'root', cutSeq: 15, cutTurn: 1, outline: [entry(1, 0), entry(2, 12), entry(3, 20)] }])
    expect(branchOf(list.byId[A]?.projectionValues)).toMatchObject({ setId: SET, index: 0 })
    expect(branchOf(list.byId[SessionId('e')]?.projectionValues)).toBeUndefined()
    expect(branchOf(undefined)).toBeUndefined()
    const split = { cutSeq: SessionSeq(15), cutTurn: 1 }
    expect(lastInheritedTurnOf(list.byId[SessionId('z')]?.projectionValues, split)).toBe(2)
    expect(lastInheritedTurnOf(undefined, split)).toBe(1)
    expect(lastInheritedTurnOf(undefined, { cutSeq: SessionSeq(0) })).toBe(0)
    expect(markOf({ mark: 'keep' }, undefined)).toBe('keep')
    expect(markOf(null, undefined)).toBeNull()
    expect(markOf({ mark: 'keep' }, { status: 'saving', mark: null })).toBeNull()
    expect(markOf({ mark: 'keep' }, { status: 'saved', mark: 'set-aside' })).toBe('set-aside')
    expect(markOf({ mark: 'keep' }, { status: 'failed', failure: { code: 'x', unknownOutcome: false } })).toBe('keep')
  })

  it('names routes and cache shares', () => {
    expect(routeText({ provider: 'openrouter', model: 'v4', reasoningEffort: 'high' }, tEn)).toBe('openrouter · v4 · high')
    expect(routeText({ provider: 'openrouter', model: 'v4' }, tEn)).toBe('openrouter · v4')
    const options: LoomRouteOption[] = [
      { selection: { provider: 'openrouter', model: 'v4' }, providerName: 'OpenRouter', modelName: 'V4 Flash', efforts: [{ id: 'high', name: 'High' }] },
      { selection: { provider: 'plain', model: 'p' }, providerName: 'Plain', modelName: 'Plain', efforts: [] },
    ]
    expect(routeLabel({ provider: 'openrouter', model: 'v4', reasoningEffort: 'high' }, options, tEn)).toBe('V4 Flash · High')
    expect(routeLabel({ provider: 'openrouter', model: 'v4' }, options, tZh)).toBe('V4 Flash')
    // An effort the catalog does not list, a model without levels, and a route outside the catalog keep their ids.
    expect(routeLabel({ provider: 'openrouter', model: 'v4', reasoningEffort: 'max' }, options, tEn)).toBe('V4 Flash · max')
    expect(routeLabel({ provider: 'plain', model: 'p', reasoningEffort: 'high' }, options, tEn)).toBe('Plain · high')
    expect(routeLabel({ provider: 'openrouter', model: 'gone', reasoningEffort: 'high' }, options, tEn)).toBe('openrouter · gone · high')
    expect(routeLabel({ provider: 'openrouter', model: 'v4' }, [], tEn)).toBe('openrouter · v4')
    expect(rowsText([4], tEn)).toBe('4')
    expect(rowsText([4, 5], tEn)).toBe('4 and 5')
    expect(rowsText([1, 2, 3], tEn)).toBe('1, 2 and 3')
    expect(rowsText([4, 5], tZh)).toBe('4、5')
    expect(rowsText([1, 2, 3], tZh)).toBe('1、2、3')
    const route = { provider: 'p', model: 'm' }
    const turnRoute = { provider: 'p', model: 'turn' }
    expect(inheritedRoute({ afterTurn: 2, lastTurn: 2, next: route, turnRoute })).toBe(route)
    expect(inheritedRoute({ afterTurn: 2, lastTurn: 2, next: null, turnRoute })).toBeUndefined()
    expect(inheritedRoute({ afterTurn: 1, lastTurn: 2, next: route, turnRoute })).toBe(turnRoute)
    expect(inheritedRoute({ afterTurn: 1, lastTurn: undefined, next: route, turnRoute: undefined })).toBeUndefined()
    expect(cachePercent(899, 1000)).toBe(89)
    expect(cachePercent(0, 0)).toBeUndefined()
  })

  it('describes each failure in both locales and shows an unknown code verbatim', () => {
    const text = (failure: Parameters<typeof failureText>[0]) => [failureText(failure, tEn), failureText(failure, tZh)]
    expect(text({ code: 'gateway/internal', unknownOutcome: true })).toEqual(['The request may have started; check the branches before you try again', '请求可能已经开始；重试前请先查看分支'])
    expect(text({ code: 'loom/unavailable', unknownOutcome: false })[0]).toBe('Loom is not available right now')
    expect(text({ code: 'loom/empty-line', line: 2, unknownOutcome: false })[0]).toBe('Line 3 is empty')
    expect(text({ code: 'loom/empty-line', unknownOutcome: false })[0]).toBe('Line 1 is empty')
    expect(text({ code: 'loom/too-many-branches', limit: 8, unknownOutcome: false })).toEqual(['At most 8 branches per request', '每次最多 8 个分支'])
    expect(text({ code: 'loom/too-many-branches', unknownOutcome: false })[0]).toBe('At most 0 branches per request')
    expect(text({ code: 'loom/set-not-found', unknownOutcome: false })[0]).toBe('The Host no longer holds this branch set')
    expect(text({ code: 'remote-access/denied', unknownOutcome: false })[0]).toBe('You cannot branch this Session')
    expect(text({ code: 'session/not-found', unknownOutcome: false })[0]).toBe('This Session was not found')
    expect(text({ code: 'session/fork-unavailable', unknownOutcome: false })).toEqual(['Could not create this branch; start it again', '无法创建此分支，请重新开始'])
    expect(text({ code: 'session/workspace-attach-failed', unknownOutcome: false })).toEqual([
      'The branch was created without its workspace; open it to check, or start it again', '分支已创建但未关联工作区；可打开查看，或重新开始',
    ])
    expect(text({ code: 'session/model-unavailable', unknownOutcome: false })).toEqual([
      'The selected model is unavailable; choose another and start again', '所选模型不可用；请更换模型后重新开始',
    ])
    expect(['not-found', 'not-ended', 'not-user-opened', 'no-cut'].map(reason => failureText({ code: 'loom/turn-unavailable', reason: reason as 'no-cut', unknownOutcome: false }, tEn))).toEqual([
      'This turn is not in the log', 'This turn has not ended', 'A user prompt did not open this turn', 'No history before this turn can be kept',
    ])
    expect(text({ code: 'loom/turn-unavailable', unknownOutcome: false })[0]).toBe('The request failed (loom/turn-unavailable)')
    expect(text({ code: 'other/code', unknownOutcome: false })).toEqual(['The request failed (other/code)', '请求失败（other/code）'])
  })

  it('reads prices, ranges, durations, paths, cuts, and lists in both locales', () => {
    expect([0, 0.0004, 0.001, 0.0062805, 0.0099, 1, 12.345].map(amount => usdText(amount, tEn)))
      .toEqual(['$0', '<$0.001', '$0.001', '$0.006', '$0.010', '$1.00', '$12.35'])
    expect(usdText(0.5, tZh)).toBe('$0.500')
    const dollars = (value: number): string => usdText(value, tEn)
    expect(rangeText(0.006, 0.01, dollars, tEn)).toBe('$0.006–$0.010')
    expect(rangeText(0.0081, 0.0082, dollars, tEn)).toBe('$0.008')
    expect([0, 400, 22_000, 59_600, 60_000, 65_000, 3_725_000].map(ms => durationText(ms, tEn)))
      .toEqual(['0s', '0s', '22s', '1m 0s', '1m 0s', '1m 5s', '62m 5s'])
    expect(durationText(65_000, tZh)).toBe('1 分 5 秒')
    expect([pathsText(['a'], tEn), pathsText(['a', 'b', 'c'], tEn), pathsText(['a', 'b', 'c', 'd', 'e'], tEn)])
      .toEqual(['a', 'a, b, c', 'a, b, c and 2 more'])
    expect(pathsText(['a', 'b', 'c', 'd'], tZh)).toBe('a、b、c 等另外 1 个')
    expect([pointReading(1, undefined, tEn), pointReading(undefined, undefined, tEn), pointReading(1, 2, tEn), pointReading(2, 2, tZh)])
      .toEqual(['After turn 1', 'Before turn 1 ended', 'During turn 2', '第 2 轮之后'])
    expect(listText(['a'], tEn)).toBe('a')
    expect(listText(['a', 'b', 'c'], tZh)).toBe('a、b、c')
  })

  it('names the reasons worktree isolation can be refused, and shows an unknown reason verbatim', () => {
    expect((['service-unavailable', 'read-only', 'no-repository', 'subdirectory', 'linked-checkout'] as const).map(reason => isolationReasonText(reason, tEn))).toEqual([
      'the worktree service is not running',
      'this Session cannot write its folder',
      'this folder is not in a git repository',
      'the git repository root lies above this folder, outside what this Session may write',
      'this folder is a linked checkout or submodule whose git data lies elsewhere',
    ])
    expect(isolationReasonText('no-repository', tZh)).toBe('此文件夹不在 git 仓库中')
    // A reason a newer Host names shows verbatim, whatever it is called.
    expect(isolationReasonText('constructor' as 'read-only', tEn)).toBe('constructor')
  })

  it('describes the refusals of isolation and apply in both locales', () => {
    const text = (failure: Parameters<typeof failureText>[0]) => [failureText(failure, tEn), failureText(failure, tZh)]
    expect(text({ code: 'loom/isolation-unavailable', isolationReason: 'no-repository', unknownOutcome: false })).toEqual([
      'Worktree isolation is unavailable: this folder is not in a git repository; no branch started',
      'worktree 隔离不可用：此文件夹不在 git 仓库中；未开始任何分支',
    ])
    expect(text({ code: 'loom/isolation-unavailable', unknownOutcome: false })[0]).toBe('The request failed (loom/isolation-unavailable)')
    expect(text({ code: 'loom/apply-dirty', paths: ['a.py', 'b.py'], unknownOutcome: false })).toEqual([
      'The source folder has uncommitted changes in a.py, b.py; nothing was applied',
      '源文件夹中 a.py、b.py 有未提交的改动，未应用任何内容',
    ])
    expect(text({ code: 'loom/apply-conflict', paths: ['a.py'], unknownOutcome: false })[0])
      .toBe('This change conflicts with the source folder in a.py; nothing was applied')
    expect(text({ code: 'loom/apply-conflict', unknownOutcome: false })[0]).toBe('This change does not apply to the source folder; nothing was applied')
    expect(text({ code: 'loom/apply-conflict', paths: [], unknownOutcome: false })[1]).toBe('此改动无法应用到源文件夹，未应用任何内容')
    expect(text({ code: 'loom/apply-dirty', unknownOutcome: false })[0]).toBe('The source folder has uncommitted changes in ; nothing was applied')
    expect(text({ code: 'loom/apply-not-isolated', unknownOutcome: false })[0]).toBe('This branch shares the folder, so it has no worktree change to apply')
    expect(text({ code: 'loom/apply-too-large', limit: 4096, unknownOutcome: false })[0]).toBe('This change is larger than the apply limit of 4096 bytes; nothing was applied')
    expect(text({ code: 'loom/apply-too-large', unknownOutcome: false })[0]).toBe('This change is larger than the apply limit of 0 bytes; nothing was applied')
    expect((['shared', 'removed', 'missing'] as const).map(worktreeReason => failureText({ code: 'loom/worktree-unavailable', worktreeReason, unknownOutcome: false }, tEn))).toEqual([
      'This branch worked in the shared folder, so it has no worktree',
      "This branch's worktree was already removed",
      "This branch's worktree is no longer registered in its repository",
    ])
    expect(text({ code: 'loom/worktree-unavailable', unknownOutcome: false })[0]).toBe('The request failed (loom/worktree-unavailable)')
    expect(text({ code: 'loom/diff-unavailable', unknownOutcome: false })).toEqual(["This Host does not hold this branch's changes", '此主机没有保存该分支的改动'])
    expect(text({ code: 'loom/worktree-cleanup-failed', paths: ['a.py'], unknownOutcome: false })[0])
      .toBe('The change was applied to the folder (a.py), but its worktree could not be removed; discard the worktree to try again')
    expect(text({ code: 'loom/worktree-cleanup-failed', unknownOutcome: false })[0]).toContain('applied to the folder (),')
    expect([1, 2].map(remaining => failureText({ code: 'loom/adopt-incomplete', remaining, unknownOutcome: false }, tEn))).toEqual([
      'Adopted, but 1 sibling could not be archived; adopt again to archive the rest',
      'Adopted, but 2 siblings could not be archived; adopt again to archive the rest',
    ])
    expect(text({ code: 'loom/adopt-incomplete', unknownOutcome: false })[0]).toContain('0 siblings')
    expect(text({ code: 'loom/not-a-fork', unknownOutcome: false })).toEqual(['This Session is not a fork, so it has no siblings', '此会话不是 fork，没有同级分支'])
  })

  it('groups the rows that share a line', () => {
    expect(duplicateRows(['a', ' b', 'a', '', 'b ', 'c', ''])).toEqual([[1, 3], [2, 5]])
    expect(duplicateRows(['a', 'b'])).toEqual([])
  })
})

describe('tree rows for branching', () => {
  it('carries each Session’s mark and last turn, and each point’s parent and running children', () => {
    const list = listOf([
      { id: 'root', outline: [entry(1, 0), entry(2, 9)] },
      { id: 'a', parent: 'root', cutSeq: 10, cutTurn: 1, createdAt: 1, mark: 'keep' },
      { id: 'b', parent: 'root', cutSeq: 10, cutTurn: 1, createdAt: 2, running: true },
    ])
    const tree = buildLoomTree({
      family: familyIn(list, 'a'), list, currentSessionId: A, running: () => undefined, collapsed: new Set(),
      marks: { [B]: { status: 'saving', mark: 'set-aside' } },
    })
    const [root, point, a, b] = tree.rows as [LoomSessionRow, LoomPointRow, LoomSessionRow, LoomSessionRow]
    expect(root).toMatchObject({ mark: null, lastTurn: 2 })
    expect(point).toMatchObject({ parentSessionId: ROOT, running: 1 })
    expect(a).toMatchObject({ mark: 'keep' })
    expect(a.lastTurn).toBeUndefined()
    expect(b).toMatchObject({ mark: 'set-aside', status: 'running' })
  })
})
