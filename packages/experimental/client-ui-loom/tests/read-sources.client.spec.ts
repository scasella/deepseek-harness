/** Keyed one-value Remote read sources: reads on first observation, re-reads on request, drops on last unsubscribe. */
import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createLoomReadSources, type LoomReadState } from '../src/client/read-sources.ts'

/** A read the test settles by hand. */
function deferred() {
  const pending: { key: string; settle: (result: RemoteResult<string> | 'reject') => void }[] = []
  const read = vi.fn((key: string) => new Promise<RemoteResult<string>>((resolve, reject) => {
    pending.push({
      key,
      settle: (result) => {
        if (result === 'reject') reject(new Error('unmounted'))
        else resolve(result)
      },
    })
  }))
  return { read, pending }
}

const ok = (value: string): RemoteResult<string> => ({ ok: true, value })
const failure = (code: 'gateway/internal'): RemoteResult<string> => ({
  ok: false,
  error: { code, message: 'boom', details: {} } as never,
})

const flush = async (): Promise<void> => { await Promise.resolve() }

describe('keyed read sources', () => {
  it('reads on the first observer only, shares the read, and shows the value', async () => {
    const { read, pending } = deferred()
    const sources = createLoomReadSources(read, 'test')
    const source = sources.source('a')
    expect(source.getSnapshot()).toEqual({ status: 'loading' })
    const first = vi.fn()
    const unsubscribe = source.subscribe(first)
    const second = source.subscribe(() => {})
    expect(read).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledWith('a')
    pending[0]!.settle(ok('one'))
    await flush()
    expect(source.getSnapshot()).toEqual({ status: 'ready', value: 'one', refreshing: false, stale: false })
    expect(first).toHaveBeenCalled()
    expect(sources.source('a')).toBe(source)
    second()
    unsubscribe()
    // The last unsubscribe drops the source, so the next observation reads afresh.
    expect(sources.source('a')).not.toBe(source)
  })

  it('does not read again when an observer returns to a source that ended a read, and retries a failed read on request', async () => {
    const { read, pending } = deferred()
    const sources = createLoomReadSources(read, 'test')
    const source = sources.source('a')
    const unsubscribe = source.subscribe(() => {})
    pending[0]!.settle(failure('gateway/internal'))
    await flush()
    expect(source.getSnapshot()).toEqual({ status: 'failed', code: 'gateway/internal' })
    // A render that unsubscribes and subscribes again must not restart a failed read.
    unsubscribe()
    const returned = source.subscribe(() => {})
    expect(read).toHaveBeenCalledOnce()
    sources.refresh('a')
    expect(read).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot()).toEqual({ status: 'loading' })
    pending[1]!.settle(ok('again'))
    await flush()
    returned()
    source.subscribe(() => {})()
    expect(read).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot()).toMatchObject({ status: 'ready', value: 'again' })
  })

  it('resumes a refresh that closing dropped, so the source never stays refreshing', async () => {
    const { read, pending } = deferred()
    const sources = createLoomReadSources(read, 'test')
    const source = sources.source('a')
    const first = source.subscribe(() => {})
    pending[0]!.settle(ok('one'))
    await flush()
    sources.refresh('a')
    expect(source.getSnapshot()).toMatchObject({ refreshing: true })
    // A render that churns its subscription drops the refresh in flight, and the returning observer starts it again.
    first()
    source.subscribe(() => {})
    expect(read).toHaveBeenCalledTimes(3)
    pending[1]!.settle(ok('dropped'))
    pending[2]!.settle(ok('two'))
    await flush()
    expect(source.getSnapshot()).toEqual({ status: 'ready', value: 'two', refreshing: false, stale: false })
  })

  it('reads again when an observer returns to a source that closed during its first read', async () => {
    const { read, pending } = deferred()
    const source = createLoomReadSources(read, 'test').source('a')
    source.subscribe(() => {})()
    source.subscribe(() => {})
    expect(read).toHaveBeenCalledTimes(2)
    // The result of the closed read is dropped; the new read's result shows.
    pending[0]!.settle(ok('stale'))
    pending[1]!.settle(ok('fresh'))
    await flush()
    expect(source.getSnapshot()).toMatchObject({ status: 'ready', value: 'fresh' })
  })

  it('reports a rejected call as a failed read without a code', async () => {
    const { read, pending } = deferred()
    const source = createLoomReadSources(read, 'test').source('a')
    source.subscribe(() => {})
    pending[0]!.settle('reject')
    await flush()
    expect(source.getSnapshot()).toEqual({ status: 'failed' })
  })

  it('refreshes while showing the last value, and keeps it marked stale when the refresh fails', async () => {
    const { read, pending } = deferred()
    const sources = createLoomReadSources(read, 'test')
    const source = sources.source('a')
    source.subscribe(() => {})
    pending[0]!.settle(ok('one'))
    await flush()
    sources.refresh('a')
    expect(source.getSnapshot()).toEqual({ status: 'ready', value: 'one', refreshing: true, stale: false })
    pending[1]!.settle(failure('gateway/internal'))
    await flush()
    expect(source.getSnapshot()).toEqual({ status: 'ready', value: 'one', refreshing: false, stale: true })
    sources.refresh('a')
    pending[2]!.settle(ok('two'))
    await flush()
    expect(source.getSnapshot()).toEqual({ status: 'ready', value: 'two', refreshing: false, stale: false })
  })

  it('queues exactly one more read for any number of requests made during a read', async () => {
    const { read, pending } = deferred()
    const sources = createLoomReadSources(read, 'test')
    const source = sources.source('a')
    source.subscribe(() => {})
    sources.refresh('a')
    sources.refresh('a')
    sources.refresh('a')
    expect(read).toHaveBeenCalledOnce()
    pending[0]!.settle(ok('one'))
    await flush()
    expect(read).toHaveBeenCalledTimes(2)
    pending[1]!.settle(ok('two'))
    await flush()
    expect(read).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot()).toMatchObject({ status: 'ready', value: 'two', refreshing: false })
  })

  it('ignores a refresh of a key nobody observes and a result that arrives after the source closed', async () => {
    const { read, pending } = deferred()
    const sources = createLoomReadSources(read, 'test')
    sources.refresh('never')
    sources.source('unobserved').getSnapshot()
    sources.refresh('unobserved')
    expect(read).not.toHaveBeenCalled()
    const source = sources.source('a')
    const unsubscribe = source.subscribe(() => {})
    unsubscribe()
    pending[0]!.settle(ok('late'))
    await flush()
    expect(source.getSnapshot()).toEqual({ status: 'loading' })
  })

  it('closes every source on dispose, so reads still in flight change nothing', async () => {
    const { read, pending } = deferred()
    const sources = createLoomReadSources(read, 'test')
    const source = sources.source('a')
    const listener = vi.fn()
    source.subscribe(listener)
    sources.dispose()
    pending[0]!.settle(ok('late'))
    await flush()
    expect(listener).not.toHaveBeenCalled()
    expect(source.getSnapshot()).toEqual<LoomReadState<string>>({ status: 'loading' })
  })
})
