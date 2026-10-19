/** Branching state: sets, retry identities, status reads, marks, and the Branch ×N form. */
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LoomBranchValue, LoomSetId, LoomSetStatus } from '@deepseek-ai/dsh-experimental-loom/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createLoomBranching, failureOf, LOOM_UNAVAILABLE, type LoomBranchingInputs } from '../src/client/branching.ts'

const ROOT = SessionId('root')
const OTHER = SessionId('other')
const A = SessionId('a')
const SET = brandString<LoomSetId>('set-1')

function ok<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function fail(code: 'gateway/internal' | 'loom/set-not-found' | 'session/not-found'): RemoteResult<never> {
  switch (code) {
    case 'gateway/internal': return { ok: false, error: new RemoteError(code, code, {}) }
    case 'loom/set-not-found': return { ok: false, error: new RemoteError(code, code, { setId: SET }) }
    case 'session/not-found': return { ok: false, error: new RemoteError(code, code, { sessionId: ROOT }) }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}

const STARTED: LoomBranchValue = {
  setId: SET,
  children: [{ index: 0, state: 'started', sessionId: A }, { index: 1, state: 'queued' }, { index: 2, state: 'failed', code: 'gateway/internal', message: 'fork failed' }],
}

function bench(overrides: Partial<LoomBranchingInputs> = {}) {
  const inputs = {
    branch: vi.fn(async () => ok(STARTED)),
    cancel: vi.fn(async () => ok({ cancelled: [1] })),
    setStatus: vi.fn(async (): Promise<RemoteResult<LoomSetStatus>> => ok({ setId: SET, sourceSessionId: ROOT, children: [] })),
    mark: vi.fn(async () => ok({ mark: 'keep' as const })),
    refreshProjection: vi.fn(async () => {}),
    openSession: vi.fn(),
    ...overrides,
  }
  return { inputs, branching: createLoomBranching(inputs) }
}

describe('failure facts', () => {
  it('keeps the limit, the empty line, and the turn reason, and marks carrier failures as unknown outcomes', () => {
    expect(failureOf(new RemoteError('loom/too-many-branches', 'x', { requested: 9, limit: 8 }))).toEqual({ code: 'loom/too-many-branches', limit: 8, unknownOutcome: false })
    expect(failureOf(new RemoteError('loom/empty-line', 'x', { index: 2 }))).toEqual({ code: 'loom/empty-line', line: 2, unknownOutcome: false })
    expect(failureOf(new RemoteError('loom/turn-unavailable', 'x', { sessionId: ROOT, turn: 1, reason: 'no-cut' })))
      .toEqual({ code: 'loom/turn-unavailable', reason: 'no-cut', unknownOutcome: false })
    expect(failureOf(new RemoteError('gateway/internal', 'x', {}))).toEqual({ code: 'gateway/internal', unknownOutcome: true })
    expect(failureOf(new RemoteError('gateway/cancelled', 'x', {}))).toEqual({ code: 'gateway/cancelled', unknownOutcome: true })
    expect(failureOf(new RemoteError('session/not-found', 'x', { sessionId: ROOT }))).toEqual({ code: 'session/not-found', unknownOutcome: false })
  })
})

describe('branch sets', () => {
  it('starts a set, follows its children with each line, and opens the first started child when asked', async () => {
    let created = 0
    const branch = vi.fn<LoomBranchingInputs['branch']>(async () => {
      created += 1
      return ok({ ...STARTED, setId: created === 1 ? SET : brandString<LoomSetId>(`set-${String(created)}`) })
    })
    const { inputs, branching } = bench({ branch })
    await expect(branching.start({ kind: 'variants', sessionId: ROOT, afterTurn: 1, lines: ['a', 'b'], samples: 2 }, { ownerSessionId: OTHER, openStarted: true }))
      .resolves.toEqual({ ok: true })
    expect(branch.mock.calls[0]?.[0]).toMatchObject({ kind: 'variants' })
    expect(branch.mock.calls[0]?.[0].requestId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(inputs.openSession).toHaveBeenCalledWith(A)
    expect(branching.state.getSnapshot().sets).toEqual([{
      setId: SET, sourceSessionId: ROOT, ownerSessionId: OTHER, kind: 'variants', lines: ['a', 'a', 'b', 'b'], lost: false, reads: 0,
      children: [{ index: 0, state: 'started', sessionId: A }, { index: 1, state: 'queued' }, { index: 2, state: 'failed', code: 'gateway/internal' }],
    }])
    await branching.start({ kind: 'steer', sessionId: ROOT, afterTurn: 1, lines: ['x'] }, { ownerSessionId: ROOT })
    await branching.start({ kind: 'regenerate', sessionId: ROOT, turn: 1, count: 1 }, { ownerSessionId: ROOT })
    await branching.start({ kind: 'edit', sessionId: ROOT, turn: 1, text: 'y' }, { ownerSessionId: ROOT })
    expect(branching.state.getSnapshot().sets.map(set => [set.setId, set.lines])).toEqual([
      ['set-1', ['a', 'a', 'b', 'b']], ['set-2', ['x']], ['set-3', []], ['set-4', []],
    ])
    expect(inputs.openSession).toHaveBeenCalledOnce()
  })

  it('follows a cancelled child that the start result reports', async () => {
    const { branching } = bench({ branch: vi.fn(async () => ok({ setId: SET, children: [{ index: 0, state: 'started' as const, sessionId: A }, { index: 1, state: 'cancelled' as const }] })) })
    await branching.start({ kind: 'steer', sessionId: ROOT, afterTurn: 1, lines: ['a', 'b'] }, { ownerSessionId: ROOT })
    expect(branching.state.getSnapshot().sets[0]?.children).toEqual([{ index: 0, state: 'started', sessionId: A }, { index: 1, state: 'cancelled' }])
  })

  it('opens nothing when the first child is queued', async () => {
    const { inputs, branching } = bench({ branch: vi.fn(async () => ok({ setId: SET, children: [{ index: 0, state: 'queued' as const }] })) })
    await branching.start({ kind: 'edit', sessionId: ROOT, turn: 1, text: 'y' }, { ownerSessionId: ROOT, openStarted: true })
    expect(inputs.openSession).not.toHaveBeenCalled()
  })

  it('keeps one entry for a set the strip adopted while its request was still in flight', async () => {
    const pending = deferred<RemoteResult<LoomBranchValue>>()
    const { inputs, branching } = bench({ branch: vi.fn(() => pending.promise) })
    const OLDER = brandString<LoomSetId>('set-0')
    branching.adopt({ setId: OLDER, sourceSessionId: ROOT, ownerSessionId: ROOT })
    const started = branching.start({ kind: 'steer', sessionId: ROOT, afterTurn: 1, lines: ['a', 'b'] }, { ownerSessionId: OTHER })
    // The family lists the first child before the Host answers, so the strip adopts the set it is about to receive.
    branching.adopt({ setId: SET, sourceSessionId: ROOT, ownerSessionId: ROOT })
    await vi.waitFor(() => { expect(branching.state.getSnapshot().sets.map(set => set.reads)).toEqual([1, 1]) })
    pending.resolve(ok(STARTED))
    await started
    expect(inputs.setStatus).toHaveBeenCalledTimes(2)
    expect(branching.state.getSnapshot().sets).toEqual([
      { setId: OLDER, sourceSessionId: ROOT, ownerSessionId: ROOT, lines: [], children: [], lost: false, reads: 1 },
      {
        setId: SET, sourceSessionId: ROOT, ownerSessionId: OTHER, kind: 'steer', lines: ['a', 'b'], lost: false, reads: 1,
        children: [{ index: 0, state: 'started', sessionId: A }, { index: 1, state: 'queued' }, { index: 2, state: 'failed', code: 'gateway/internal' }],
      },
    ])
  })

  it('reuses the request id only to retry a draft whose outcome is unknown', async () => {
    const results: RemoteResult<LoomBranchValue>[] = [fail('gateway/internal'), ok(STARTED), fail('session/not-found'), fail('session/not-found')]
    const branch = vi.fn<LoomBranchingInputs['branch']>(async () => results.shift()!)
    const { branching } = bench({ branch })
    const draft = { kind: 'regenerate', sessionId: ROOT, turn: 1, count: 2 } as const
    const first = await branching.start(draft, { ownerSessionId: ROOT })
    expect(first).toEqual({ ok: false, failure: { code: 'gateway/internal', unknownOutcome: true } })
    await branching.start(draft, { ownerSessionId: ROOT })
    const ids = (): string[] => branch.mock.calls.map(([request]) => request.requestId)
    expect(ids()[1]).toBe(ids()[0])
    await branching.start(draft, { ownerSessionId: ROOT })
    await branching.start(draft, { ownerSessionId: ROOT })
    expect(new Set(ids()).size).toBe(3)
  })

  it('reports an unmounted namespace as unavailable', async () => {
    const { branching } = bench({ branch: vi.fn(() => Promise.reject(new Error('unmounted'))) })
    await expect(branching.start({ kind: 'regenerate', sessionId: ROOT, turn: 1, count: 1 }, { ownerSessionId: ROOT }))
      .resolves.toEqual({ ok: false, failure: { code: LOOM_UNAVAILABLE, unknownOutcome: false } })
  })

  it('withdraws queued children, and marks a set the Host no longer holds as lost', async () => {
    const cancel = vi.fn<LoomBranchingInputs['cancel']>(async () => ok({ cancelled: [1] }))
    const { branching } = bench({ cancel })
    await branching.start({ kind: 'steer', sessionId: ROOT, afterTurn: 1, lines: ['a', 'b', 'c'] }, { ownerSessionId: ROOT })
    branching.adopt({ setId: brandString<LoomSetId>('set-2'), sourceSessionId: ROOT, ownerSessionId: ROOT })
    await expect(branching.cancel(SET, [1])).resolves.toEqual({ ok: true })
    expect(cancel).toHaveBeenCalledWith({ setId: SET, indices: [1] })
    expect(branching.state.getSnapshot().sets[0]?.children.map(child => child.state)).toEqual(['started', 'cancelled', 'failed'])
    cancel.mockResolvedValueOnce(fail('session/not-found'))
    await expect(branching.cancel(SET)).resolves.toMatchObject({ ok: false, failure: { code: 'session/not-found' } })
    expect(cancel).toHaveBeenLastCalledWith({ setId: SET })
    expect(branching.state.getSnapshot().sets[0]?.lost).toBe(false)
    cancel.mockResolvedValueOnce(fail('loom/set-not-found'))
    await branching.cancel(SET)
    expect(branching.state.getSnapshot().sets[0]?.lost).toBe(true)
    cancel.mockRejectedValueOnce(new Error('unmounted'))
    await expect(branching.cancel(SET)).resolves.toMatchObject({ ok: false, failure: { code: LOOM_UNAVAILABLE } })
    branching.dismiss(SET)
    expect(branching.state.getSnapshot().sets.map(set => set.setId)).toEqual(['set-2'])
  })

  it('reads a set again when the Host withdrew fewer of the named queued children than the browser holds as queued', async () => {
    const cancel = vi.fn<LoomBranchingInputs['cancel']>(async () => ok({ cancelled: [] }))
    // The Host still reports child 1 as queued while it forks it.
    const setStatus = vi.fn(async () => ok<LoomSetStatus>({ setId: SET, sourceSessionId: ROOT, children: STARTED.children }))
    const { inputs, branching } = bench({ cancel, setStatus })
    await branching.start({ kind: 'steer', sessionId: ROOT, afterTurn: 1, lines: ['a', 'b', 'c'] }, { ownerSessionId: ROOT })
    // Only child 1 is queued: naming child 0 alone, or a set the browser does not follow, starts no read.
    await branching.cancel(SET, [0])
    await branching.cancel(brandString<LoomSetId>('set-9'))
    expect(inputs.setStatus).not.toHaveBeenCalled()
    // Child 1 left the queue on the Host before the call arrived.
    await branching.cancel(SET, [1])
    expect(inputs.setStatus).toHaveBeenCalledOnce()
    await vi.waitFor(() => { expect(branching.state.getSnapshot().sets[0]?.reads).toBe(1) })
    await branching.cancel(SET)
    expect(inputs.setStatus).toHaveBeenCalledTimes(2)
    cancel.mockResolvedValueOnce(ok({ cancelled: [1] }))
    await branching.cancel(SET)
    expect(inputs.setStatus).toHaveBeenCalledTimes(2)
  })

  it('adopts a running set once, reads its status without overlapping reads, and keeps the last children on a failed read', async () => {
    const reads: ReturnType<typeof deferred<RemoteResult<LoomSetStatus>>>[] = []
    const setStatus = vi.fn((_request: { setId: LoomSetId }) => {
      const read = deferred<RemoteResult<LoomSetStatus>>()
      reads.push(read)
      return read.promise
    })
    const { branching } = bench({ setStatus })
    branching.refresh(SET)
    expect(setStatus).not.toHaveBeenCalled()
    branching.adopt({ setId: SET, sourceSessionId: ROOT, ownerSessionId: OTHER })
    branching.adopt({ setId: SET, sourceSessionId: ROOT, ownerSessionId: OTHER })
    expect(branching.state.getSnapshot().sets).toEqual([
      { setId: SET, sourceSessionId: ROOT, ownerSessionId: OTHER, lines: [], children: [], lost: false, reads: 0 },
    ])
    branching.refresh(SET)
    branching.refresh(SET)
    expect(setStatus).toHaveBeenCalledOnce()
    reads[0]!.resolve(ok({
      setId: SET, sourceSessionId: ROOT,
      children: [{ index: 0, state: 'failed', sessionId: A, code: 'gateway/internal', message: 'prompt failed' }, { index: 1, state: 'cancelled' }],
    }))
    await vi.waitFor(() => { expect(setStatus).toHaveBeenCalledTimes(2) })
    expect(branching.state.getSnapshot().sets[0]?.children).toEqual([
      { index: 0, state: 'failed', sessionId: A, code: 'gateway/internal' }, { index: 1, state: 'cancelled' },
    ])
    expect(branching.state.getSnapshot().sets[0]?.reads).toBe(1)
    reads[1]!.resolve(fail('gateway/internal'))
    await vi.waitFor(() => { expect(reads).toHaveLength(2) })
    branching.refresh(SET)
    await vi.waitFor(() => { expect(setStatus).toHaveBeenCalledTimes(3) })
    reads[2]!.reject(new Error('unmounted'))
    await vi.waitFor(() => { expect(branching.state.getSnapshot().sets[0]?.children).toHaveLength(2) })
    branching.refresh(SET)
    await vi.waitFor(() => { expect(setStatus).toHaveBeenCalledTimes(4) })
    reads[3]!.resolve(fail('loom/set-not-found'))
    await vi.waitFor(() => { expect(branching.state.getSnapshot().sets[0]?.lost).toBe(true) })
    // Only a read that returned the children counts.
    expect(branching.state.getSnapshot().sets[0]?.reads).toBe(1)
  })

  it('drops results that arrive after disposal and starts no later reads', async () => {
    const read = deferred<RemoteResult<LoomSetStatus>>()
    const branchResult = deferred<RemoteResult<LoomBranchValue>>()
    const { inputs, branching } = bench({ setStatus: vi.fn(() => read.promise), branch: vi.fn(() => branchResult.promise) })
    branching.adopt({ setId: SET, sourceSessionId: ROOT, ownerSessionId: ROOT })
    const started = branching.start({ kind: 'edit', sessionId: ROOT, turn: 1, text: 'y' }, { ownerSessionId: ROOT, openStarted: true })
    branching.dispose()
    read.resolve(ok({ setId: SET, sourceSessionId: ROOT, children: [{ index: 0, state: 'queued' }] }))
    branchResult.resolve(ok(STARTED))
    await expect(started).resolves.toEqual({ ok: true })
    expect(inputs.openSession).not.toHaveBeenCalled()
    expect(branching.state.getSnapshot().sets).toEqual([
      { setId: SET, sourceSessionId: ROOT, ownerSessionId: ROOT, lines: [], children: [], lost: false, reads: 0 },
    ])
    branching.refresh(SET)
    expect(inputs.setStatus).toHaveBeenCalledOnce()
  })
})

describe('private marks', () => {
  it('shows a mark while it saves and until the projections are read again', async () => {
    const refresh = deferred<undefined>()
    const mark = deferred<RemoteResult<{ mark: 'keep' | 'set-aside' | null }>>()
    const { inputs, branching } = bench({ mark: vi.fn(() => mark.promise), refreshProjection: vi.fn(() => refresh.promise) })
    const saved = branching.setMark(A, 'keep')
    expect(branching.state.getSnapshot().marks[A]).toEqual({ status: 'saving', mark: 'keep' })
    mark.resolve(ok({ mark: 'keep' }))
    await expect(saved).resolves.toEqual({ ok: true })
    expect(branching.state.getSnapshot().marks[A]).toEqual({ status: 'saved', mark: 'keep' })
    expect(inputs.refreshProjection).toHaveBeenCalledWith(A)
    refresh.resolve(undefined)
    await vi.waitFor(() => { expect(branching.state.getSnapshot().marks).toEqual({}) })
  })

  it('settles after a failed projection read and keeps a newer mark', async () => {
    const refresh = deferred<undefined>()
    const { branching } = bench({ refreshProjection: vi.fn(() => refresh.promise) })
    await branching.setMark(A, 'keep')
    refresh.reject(new Error('read failed'))
    await vi.waitFor(() => { expect(branching.state.getSnapshot().marks).toEqual({}) })
    const late = deferred<undefined>()
    const { branching: third } = bench({ refreshProjection: vi.fn(() => late.promise) })
    await third.setMark(A, 'keep')
    const pending = third.setMark(A, 'set-aside')
    late.resolve(undefined)
    await pending
    await vi.waitFor(() => { expect(third.state.getSnapshot().marks).toEqual({}) })
  })

  it('reports a failed save, and ignores a result a newer save superseded', async () => {
    const first = deferred<RemoteResult<{ mark: 'keep' | 'set-aside' | null }>>()
    const results = [first.promise, Promise.resolve(fail('session/not-found')), Promise.reject(new Error('unmounted'))]
    const { branching } = bench({ mark: vi.fn(() => results.shift()!) })
    const stale = branching.setMark(A, 'keep')
    await expect(branching.setMark(A, 'set-aside')).resolves.toMatchObject({ ok: false, failure: { code: 'session/not-found' } })
    expect(branching.state.getSnapshot().marks[A]).toEqual({ status: 'failed', failure: { code: 'session/not-found', unknownOutcome: false } })
    first.resolve(ok({ mark: 'keep' }))
    await expect(stale).resolves.toEqual({ ok: true })
    expect(branching.state.getSnapshot().marks[A]?.status).toBe('failed')
    const staleFailure = deferred<RemoteResult<{ mark: 'keep' | 'set-aside' | null }>>()
    const mark = vi.fn<LoomBranchingInputs['mark']>().mockReturnValueOnce(staleFailure.promise).mockResolvedValueOnce(ok({ mark: null }))
    const { branching: other } = bench({ mark })
    const losing = other.setMark(A, 'keep')
    await other.setMark(A, null)
    staleFailure.resolve(fail('session/not-found'))
    await expect(losing).resolves.toMatchObject({ ok: false })
    await expect(branching.setMark(A, 'keep')).resolves.toMatchObject({ ok: false, failure: { code: LOOM_UNAVAILABLE } })
  })
})

describe('Branch ×N form', () => {
  it('opens with two empty lines, keeps an open draft for the same target, and replaces it for another', () => {
    const { branching } = bench()
    branching.openForm(OTHER, { sourceSessionId: ROOT, afterTurn: 1 })
    expect(branching.state.getSnapshot().forms[OTHER]).toEqual({
      sourceSessionId: ROOT, afterTurn: 1, rows: ['', ''], samples: 1, selection: null, starting: false, failure: null,
    })
    branching.editForm(OTHER, { rows: ['a'] })
    const before = branching.state.getSnapshot()
    branching.openForm(OTHER, { sourceSessionId: ROOT, afterTurn: 1 })
    expect(branching.state.getSnapshot()).toBe(before)
    branching.openForm(OTHER, { sourceSessionId: ROOT, afterTurn: 2 })
    expect(branching.state.getSnapshot().forms[OTHER]?.rows).toEqual(['', ''])
    branching.editForm(ROOT, { rows: ['ignored'] })
    expect(branching.state.getSnapshot().forms[ROOT]).toBeUndefined()
    branching.closeForm(OTHER)
    expect(branching.state.getSnapshot().forms).toEqual({})
  })

  it('starts a steer set or a variants set from the trimmed lines and closes on success', async () => {
    const branch = vi.fn<LoomBranchingInputs['branch']>(async () => ok(STARTED))
    const { inputs, branching } = bench({ branch })
    await expect(branching.submitForm(ROOT)).resolves.toBe(false)
    branching.openForm(ROOT, { sourceSessionId: ROOT, afterTurn: 1 })
    await expect(branching.submitForm(ROOT)).resolves.toBe(false)
    expect(inputs.branch).not.toHaveBeenCalled()
    branching.editForm(ROOT, { rows: [' a ', 'b'], selection: { provider: 'p', model: 'm' } })
    await expect(branching.submitForm(ROOT)).resolves.toBe(true)
    expect(inputs.branch).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'steer', sessionId: ROOT, afterTurn: 1, lines: ['a', 'b'], selection: { provider: 'p', model: 'm' },
    }))
    expect(branching.state.getSnapshot().forms).toEqual({})
    branching.openForm(ROOT, { sourceSessionId: ROOT, afterTurn: 1 })
    branching.editForm(ROOT, { rows: ['a'], samples: 3 })
    await branching.submitForm(ROOT)
    expect(inputs.branch).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'variants', lines: ['a'], samples: 3 }))
    expect(branch.mock.lastCall?.[0]).not.toHaveProperty('selection')
  })

  it('keeps the draft with its failure, ignores a second start in flight, and leaves a form replaced meanwhile alone', async () => {
    const results = [deferred<RemoteResult<LoomBranchValue>>(), deferred<RemoteResult<LoomBranchValue>>()]
    const queue = [...results]
    const { inputs, branching } = bench({ branch: vi.fn(() => queue.shift()!.promise) })
    branching.openForm(ROOT, { sourceSessionId: ROOT, afterTurn: 1 })
    branching.editForm(ROOT, { rows: ['a'] })
    const first = branching.submitForm(ROOT)
    expect(branching.state.getSnapshot().forms[ROOT]?.starting).toBe(true)
    await expect(branching.submitForm(ROOT)).resolves.toBe(false)
    expect(inputs.branch).toHaveBeenCalledOnce()
    results[0]!.resolve(fail('session/not-found'))
    await expect(first).resolves.toBe(false)
    expect(branching.state.getSnapshot().forms[ROOT]).toMatchObject({ starting: false, failure: { code: 'session/not-found' }, rows: ['a'] })
    const second = branching.submitForm(ROOT)
    branching.openForm(ROOT, { sourceSessionId: ROOT, afterTurn: 4 })
    results[1]!.resolve(ok(STARTED))
    await expect(second).resolves.toBe(false)
    expect(branching.state.getSnapshot().forms[ROOT]).toMatchObject({ afterTurn: 4, rows: ['', ''] })
  })
})
