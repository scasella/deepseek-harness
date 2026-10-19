// @vitest-environment jsdom
/** Family catalog search targets visible families before ranking and exposes ownership explicitly. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { createMultiverseSearch, multiverseFamilies, multiverseSearchKey } from '../src/client/multiverse.ts'
import { MultiversePage, MultiverseIcon, type MultiversePageProps } from '../src/client/MultiversePage.tsx'
import { listOf, tEn } from './fixtures.client.ts'

afterEach(cleanup)
const list = listOf([{ id: 'root' }, { id: 'a', parent: 'root', cutSeq: 2, running: true }, { id: 'solo' }])
describe('Multiverse catalog', () => {
  it('derives each visible family once and skips blank, missing, and subagent rows', () => {
    const data = { ...list, ids: [...list.ids, SessionId('missing'), SessionId('blank'), SessionId('sub')], byId: {
      ...list.byId, [SessionId('blank')]: { ...list.byId[SessionId('root')]!, id: SessionId('blank'), blank: true }, [SessionId('sub')]: { ...list.byId[SessionId('root')]!, id: SessionId('sub'), origin: 'subagent' as const },
    } }
    expect(multiverseFamilies(data).map(f => f.nodes.map(n => n.sessionId))).toEqual([['root', 'a']])
    const two = listOf([{ id: 'r1' }, { id: 'c1', parent: 'r1' }, { id: 'r2' }, { id: 'c2', parent: 'r2' }])
    expect(multiverseFamilies({ ...two, byId: { ...two.byId, [SessionId('c2')]: { ...two.byId[SessionId('c2')]!, updatedAt: 10 } } }).map(f => f.rootId)).toEqual(['r2', 'r1'])
  })
  it('canonicalizes membership and passes scope and ids to authorized search, while blank queries stay local', async () => {
    const search = vi.fn(async () => ({ ok: true as const, value: { items: [], hasMore: false } }))
    const reads = createMultiverseSearch(search)
    const key = multiverseSearchKey({ query: 'find', scope: 'inherited', sessionIds: [SessionId('b'), SessionId('a'), SessionId('a')] })
    const source = reads.source(key), stop = source.subscribe(() => {})
    await vi.waitFor(() => { expect(source.getSnapshot().status).toBe('ready') })
    expect(search).toHaveBeenCalledWith('find', expect.any(AbortSignal), 'inherited', ['a', 'b'])
    const blank = reads.source(multiverseSearchKey({ query: ' ', sessionIds: [] })), stopBlank = blank.subscribe(() => {})
    await vi.waitFor(() => { expect(blank.getSnapshot().status).toBe('ready') })
    expect(search).toHaveBeenCalledOnce()
    stop(); stopBlank(); reads.dispose()
  })
  it('filters by family and ownership, opens child Sessions, and keeps search failures actionable', () => {
    let result: unknown = { status: 'ready', value: { items: [], hasMore: false }, refreshing: false }
    const read = vi.fn((_key: string) => result), openSession = vi.fn(), retrySearch = vi.fn()
    const props = {
      useSessions: (select: (s: typeof list) => unknown) => select(list),
      useLoomFamilySearch: read, openSession, retrySearch, t: tEn,
    } as MultiversePageProps
    const b = render(<MultiversePage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /title a.*Running/ }))
    expect(openSession).toHaveBeenCalledWith('a')
    fireEvent.change(screen.getByRole('combobox', { name: 'Message scope' }), { target: { value: 'all' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Family' }), { target: { value: 'root' } })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'absent' } })
    expect(JSON.parse(read.mock.lastCall![0])).toEqual({ query: 'absent', sessionIds: ['a', 'root'] })
    expect(screen.getByText('No matching fork families')).toBeTruthy()
    result = { status: 'loading' }; b.rerender(<MultiversePage {...props} />)
    expect(screen.getByRole('status')).toBeTruthy()
    result = { status: 'failed' }; b.rerender(<MultiversePage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })); expect(retrySearch).toHaveBeenCalled()
    result = { status: 'ready', value: { items: [{ sessionId: 'a', snippet: 'content match' }], hasMore: true } }; b.rerender(<MultiversePage {...props} />)
    expect(screen.getByText('content match')).toBeTruthy()
    expect(screen.getByText(/Narrow the family/)).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Message scope' }), { target: { value: 'inherited' } })
    expect(JSON.parse(read.mock.lastCall![0])).toMatchObject({ scope: 'inherited' })
    cleanup(); render(<MultiversePage {...props} useSessions={(select => select(listOf([])))} />)
    expect(screen.getByText(/No fork families yet/)).toBeTruthy()
    render(<MultiverseIcon {...{ size: 16 } as Parameters<typeof MultiverseIcon>[0]} />)
  })
})
