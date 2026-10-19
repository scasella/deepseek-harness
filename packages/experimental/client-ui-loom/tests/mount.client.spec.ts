/** The optional `loom` namespace, dictionaries, and family sources leave with the Client plugin. */
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { inject, mountLoom, registerLoom } from '../src/client/mount.ts'
import { apply as hostApply } from '../src/index.ts'

const CONTRIBUTION: TypertRemoteContribution = { package: '@deepseek-ai/dsh-experimental-loom', descriptors: [] }
const ROOT = SessionId('root')

async function fixture() {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  const mounted: TypertRemoteContribution[] = []
  class TestRemote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(value: TypertRemoteContribution) { mounted.push(value); return unmount }
  }
  new TestRemote()
  const list = createSnapshotStore<SessionListState>({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} })
  ctx.provide('sessions', { list } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  return { ctx, unmount, mounted, list }
}

function forked(child: string): SessionListState {
  const rows: SessionSummary[] = [
    { id: ROOT, displayTitle: 'root', running: false, blank: false, updatedAt: 1, retainedBy: {} },
    { id: SessionId(child), displayTitle: child, parentId: ROOT, running: false, blank: false, updatedAt: 2, retainedBy: {} },
  ]
  return { ids: rows.map(row => row.id), byId: Object.fromEntries(rows.map(row => [row.id, row])), phase: 'ready', projectionsBySession: {} }
}

describe('Loom browser plugin', () => {
  it('keeps the Host half inert and declares the browser services it reads', () => {
    hostApply()
    expect(inject).toEqual(['remote', 'sessions', 'locale'])
  })

  it('mounts the Remote with the dictionaries and withdraws both on disposal', async () => {
    const b = await fixture()
    try {
      const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountLoom(ctx, CONTRIBUTION) })
      await fiber
      expect(b.mounted).toEqual([CONTRIBUTION])
      expect(b.ctx.locale.bind('loom')('view.loom')).not.toBe('view.loom')
      await fiber.dispose()
      expect(b.unmount).toHaveBeenCalledOnce()
      expect(b.ctx.locale.bind('loom')('view.loom')).toBe('view.loom')
    } finally { await b.ctx.fiber.dispose() }
  })

  it('serves family sources over the client Session list until its fiber ends', async () => {
    const b = await fixture()
    try {
      let families: ReturnType<typeof registerLoom> | undefined
      const fiber = b.ctx.plugin({ inject: ['sessions', 'locale'], apply: (ctx) => { families = registerLoom(ctx) } })
      await fiber
      const source = families!.source(ROOT)
      source.subscribe(() => {})
      expect(source.getSnapshot()).toEqual({ status: 'loading' })
      b.list.set(forked('a'))
      const members = (): unknown => {
        const state = source.getSnapshot()
        return state.status === 'ready' ? state.family.nodes.map(node => node.sessionId) : state.status
      }
      expect(members()).toEqual(['root', 'a'])
      await fiber.dispose()
      b.list.set(forked('b'))
      expect(members()).toEqual(['root', 'a'])
    } finally { await b.ctx.fiber.dispose() }
  })

  it('withdraws the Remote when registration fails', async () => {
    const b = await fixture()
    try {
      vi.spyOn(b.ctx.locale, 'register').mockImplementationOnce(() => { throw new Error('dictionary refused') })
      await expect(mountLoom(b.ctx, CONTRIBUTION)).rejects.toThrow('dictionary refused')
      expect(b.unmount).toHaveBeenCalledOnce()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('loads the browser entry through its generated optional Remote contribution', async () => {
    const b = await fixture()
    vi.doMock('@deepseek-ai/dsh-experimental-loom/remote', () => ({ default: CONTRIBUTION }))
    try {
      const browser = await import('../src/client/index.ts')
      expect(browser.inject).toEqual(inject)
      const fiber = b.ctx.plugin({ inject: [...browser.inject], apply: browser.apply })
      await fiber
      expect(b.mounted).toEqual([CONTRIBUTION])
      await fiber.dispose()
      expect(b.unmount).toHaveBeenCalledOnce()
    } finally {
      await b.ctx.fiber.dispose()
      vi.doUnmock('@deepseek-ai/dsh-experimental-loom/remote')
    }
  })
})
