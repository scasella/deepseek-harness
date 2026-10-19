/** The optional `loom` namespace, dictionaries, sources, slot entries, and tree key rows leave with the Client plugin. */
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SessionBinding, SessionListState, SessionReference, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ShortcutBinding, ShortcutFixedCommand } from '@deepseek-ai/dsh-client-shortcuts/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { LoomRequestView } from '@deepseek-ai/dsh-experimental-loom/types'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { ForkBand } from '../src/client/ForkBand.tsx'
import type { LoomLinkInjected } from '../src/client/links.ts'
import { LoomView, type LoomViewInjected } from '../src/client/LoomView.tsx'
import { inject, mountLoom, registerLoom } from '../src/client/mount.ts'
import { VariantChip } from '../src/client/VariantChip.tsx'
import { apply as hostApply } from '../src/index.ts'

const CONTRIBUTION: TypertRemoteContribution = { package: '@deepseek-ai/dsh-experimental-loom', descriptors: [] }
const ROOT = SessionId('root')
const CHILD = SessionId('child')
const SLOTS = ['conversation.chat.fork-cut', 'conversation.session.header.actions', 'conversation.view'] as const

const VIEW: LoomRequestView = {
  route: { provider: 'deepseek', model: 'v4' },
  systemPrompt: { chars: 1, text: 'x' },
  tools: { names: [], addedThisTurn: [], removedThisTurn: [] },
  messages: [],
  inheritedTurns: 0,
  ownTurns: 1,
}

function forked(child: string): SessionListState {
  const rows: SessionSummary[] = [
    { id: ROOT, displayTitle: 'root', running: false, blank: false, updatedAt: 1, retainedBy: {} },
    { id: SessionId(child), displayTitle: child, parentId: ROOT, running: false, blank: false, updatedAt: 2, retainedBy: {} },
  ]
  return { ids: rows.map(row => row.id), byId: Object.fromEntries(rows.map(row => [row.id, row])), phase: 'ready', projectionsBySession: {} }
}

async function fixture(options: { shortcuts?: boolean } = {}) {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  const mounted: TypertRemoteContribution[] = []
  const requestAt = vi.fn(async () => ({ ok: true as const, value: VIEW }))
  class TestRemote extends Service {
    constructor() { super(ctx, 'remote') }
    // Like the Gateway, the mounted namespace lives on a fiber outside the caller's ancestry.
    async $mount(value: TypertRemoteContribution) {
      mounted.push(value)
      const namespace = ctx.plugin({ apply: (inner) => { inner.provide('remote.loom', { requestAt }) } })
      await namespace
      return async () => {
        await namespace.dispose()
        await unmount()
      }
    }
  }
  new TestRemote()
  const list = createSnapshotStore<SessionListState>({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} })
  const release = vi.fn()
  const loadOlder = vi.fn(() => Promise.reject(new Error('page failed')))
  // The plugin reads only the event window's `hasMore` and `session.loadOlder` from a binding.
  const binding: SessionBinding = {
    sessionId: CHILD, eventSource: createSnapshotStore({ hasMore: false }) as never, session: { loadOlder } as never, ctx: {} as never,
  }
  const reference: SessionReference = { sessionId: CHILD, binding, ready: Promise.resolve(binding), release, [Symbol.dispose]: release }
  const retain = vi.fn(() => reference)
  const refreshProjections = vi.fn(() => Promise.reject(new Error('read failed')))
  ctx.provide('sessions', { list, retain, refreshProjections, binding: (id: SessionId) => id === CHILD ? binding : undefined } as never)
  const chat = createSnapshotStore<ChatSnapshot | undefined>(undefined)
  const conversationBinding = vi.fn(() => ({ target: () => chat }))
  ctx.provide('uiConversation', { binding: conversationBinding } as never)
  const openSession = vi.fn()
  ctx.provide('uiWorkspace', { openSession } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fixed: ShortcutFixedCommand[] = []
  const unregister = vi.fn()
  if (options.shortcuts !== false) {
    ctx.provide('shortcuts', {
      registerFixed: (command: ShortcutFixedCommand) => { fixed.push(command); return unregister },
      describeBinding: (candidate: ShortcutBinding) => ({ binding: null, keys: [candidate.code], issue: null, conflicts: [] }),
    } as never)
  }
  await ctx.plugin(SlotRegistry).await()
  const declare = (): (() => void) => ctx.slots.register({
    name: 'root',
    children: Object.fromEntries(SLOTS.map(name => [name, { kind: 'list', scope: 'session' }])),
  } as never, () => null)
  const collapse = declare()
  const entry = (name: typeof SLOTS[number], component: unknown): StoredEntry | undefined =>
    ctx.slots.entries(name).find(candidate => candidate.component === component)
  return {
    ctx, unmount, mounted, list, requestAt, retain, release, loadOlder, refreshProjections, conversationBinding,
    openSession, fixed, unregister, declare, collapse, entry, chat,
  }
}

/** Narrow an entry's injected face to the Loom links it must carry. */
function isLinks(value: Record<string, unknown>): value is Record<string, unknown> & LoomLinkInjected {
  return typeof value.openSession === 'function' && typeof value.refreshProjection === 'function' && typeof value.keyedHooks === 'object'
}

/** Narrow the view entry's injected face. */
function isView(value: Record<string, unknown>): value is Record<string, unknown> & LoomViewInjected {
  return isLinks(value) && typeof value.loadOlder === 'function'
}

function injectedOf<T>(entry: StoredEntry | undefined, guard: (value: Record<string, unknown>) => value is Record<string, unknown> & T): T {
  const value = entry?.inject?.()
  if (value === undefined || !guard(value)) throw new Error('Loom entry lacks its injected face')
  return value
}

describe('Loom browser plugin', () => {
  it('keeps the Host half inert and declares the browser services it reads', () => {
    hostApply()
    expect(inject).toEqual(['remote', 'sessions', 'locale'])
  })

  it('registers the fork band, header chip, view tab, and tree key rows, and removes them on disposal', async () => {
    const b = await fixture()
    try {
      const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountLoom(ctx, CONTRIBUTION) })
      await fiber
      expect(b.mounted).toEqual([CONTRIBUTION])
      expect(b.ctx.locale.bind('loom')('view.loom')).toBe('Loom')
      expect(b.entry('conversation.chat.fork-cut', ForkBand)).toMatchObject({ options: { id: 'loom-fork-band', order: 0 }, locale: 'loom' })
      expect(b.entry('conversation.session.header.actions', VariantChip)).toMatchObject({ options: { id: 'loom-variant', order: -30 }, locale: 'loom' })
      const view = b.entry('conversation.view', LoomView)
      expect(view).toMatchObject({ options: { id: 'loom', order: 20 }, locale: 'loom' })
      expect(view?.store).toBeDefined()
      expect(resolveSlotLabel(view?.options.label)).toBe('Loom')
      expect(b.fixed.map(command => [command.id, command.group, command.keys, command.label()])).toEqual([
        ['loom.tree.move', 'tree', ['ArrowUp', 'ArrowDown'], 'Move in the fork family tree'],
        ['loom.tree.collapse-expand', 'tree', ['ArrowLeft', 'ArrowRight'], 'Collapse or expand a fork family node'],
        ['loom.tree.open', 'tree', ['Enter'], 'Read a Session from the fork family tree'],
      ])
      await fiber.dispose()
      expect(b.unmount).toHaveBeenCalledOnce()
      expect(b.unregister).toHaveBeenCalledTimes(3)
      for (const name of SLOTS) expect(b.ctx.slots.entries(name)).toEqual([])
      expect(b.ctx.locale.bind('loom')('view.loom')).toBe('view.loom')
    } finally { await b.ctx.fiber.dispose() }
  })

  it('injects navigation, projection refresh, family, reader, and request sources', async () => {
    const b = await fixture()
    try {
      const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountLoom(ctx, CONTRIBUTION) })
      await fiber
      const links = injectedOf(b.entry('conversation.chat.fork-cut', ForkBand), isLinks)
      expect(b.entry('conversation.session.header.actions', VariantChip)!.inject!()).toBe(links)
      links.openSession(ROOT)
      expect(b.openSession).toHaveBeenCalledWith(ROOT)
      links.refreshProjection(ROOT)
      expect(b.refreshProjections).toHaveBeenCalledWith(ROOT)
      b.list.set(forked('child'))
      const family = links.keyedHooks.loomFamily(CHILD)
      family.subscribe(() => {})
      expect(family.getSnapshot()).toMatchObject({ status: 'ready', family: { rootId: 'root' } })
      const view = injectedOf(b.entry('conversation.view', LoomView), isView)
      expect(view.keyedHooks.loomFamily(CHILD)).toBe(family)
      view.loadOlder(CHILD)
      view.loadOlder(ROOT)
      expect(b.loadOlder).toHaveBeenCalledOnce()
      const reader = view.keyedHooks.loomReader(CHILD)
      reader.subscribe(() => {})
      expect(b.retain).toHaveBeenCalledWith(CHILD, { source: 'loom' })
      await Promise.resolve()
      await Promise.resolve()
      expect(b.conversationBinding).toHaveBeenCalledOnce()
      const request = view.keyedHooks.loomRequest(`${CHILD}:9`)
      request.subscribe(() => {})
      expect(b.requestAt).toHaveBeenCalledWith({ sessionId: CHILD, seq: SessionSeq(9) }, expect.any(AbortSignal))
      await fiber.dispose()
      expect(b.release).toHaveBeenCalledOnce()
      b.list.set(forked('other'))
      expect(family.getSnapshot()).toMatchObject({ status: 'ready', family: { focusId: 'child' } })
    } finally { await b.ctx.fiber.dispose() }
  })

  it('re-registers after the conversation slots are collapsed and declared again', async () => {
    const b = await fixture()
    try {
      await b.ctx.plugin({ inject: [...inject], apply: ctx => mountLoom(ctx, CONTRIBUTION) })
      expect(b.entry('conversation.view', LoomView)).toBeDefined()
      b.collapse()
      expect(b.entry('conversation.view', LoomView)).toBeUndefined()
      b.declare()
      await Promise.resolve()
      expect(b.entry('conversation.view', LoomView)).toBeDefined()
      expect(b.entry('conversation.chat.fork-cut', ForkBand)).toBeDefined()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('mounts without a shortcut registry and registers the slots alone', async () => {
    const b = await fixture({ shortcuts: false })
    try {
      const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountLoom(ctx, CONTRIBUTION) })
      await fiber
      expect(b.entry('conversation.view', LoomView)).toBeDefined()
      expect(b.fixed).toEqual([])
      await fiber.dispose()
      expect(b.unmount).toHaveBeenCalledOnce()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('serves family sources over the client Session list until its fiber ends', async () => {
    const b = await fixture()
    try {
      let families: ReturnType<typeof registerLoom> | undefined
      const fiber = b.ctx.plugin({
        inject: ['sessions', 'locale', 'slots', 'uiConversation', 'uiWorkspace'],
        apply: (ctx) => { families = registerLoom(ctx, b.requestAt) },
      })
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

  it('withdraws the Remote and the key rows when registration fails', async () => {
    const b = await fixture()
    try {
      vi.spyOn(b.ctx.locale, 'register').mockImplementationOnce(() => { throw new Error('dictionary refused') })
      await expect(mountLoom(b.ctx, CONTRIBUTION)).rejects.toThrow('dictionary refused')
      expect(b.unmount).toHaveBeenCalledOnce()
      expect(b.unregister).toHaveBeenCalledTimes(b.fixed.length)
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
