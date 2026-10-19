/** Source-safe lifecycle for the optional `loom` Remote and the Loom browser registrations. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { createLoomFamilySources, type LoomFamilySources } from './family.ts'
import { ForkBand } from './ForkBand.tsx'
import type { LoomLinkInjected } from './links.ts'
import { en, NS, zh, type LoomKey } from './locales.ts'
import { LOOM_VIEW_ID, LoomView, type LoomViewInjected } from './LoomView.tsx'
import { createLoomReaderSources, type LoomReaderInputs } from './reader.ts'
import { createLoomRequestSources, type LoomRequestInputs } from './requests.ts'
import { registerLoomTreeKeys } from './shortcuts.ts'
import { VariantChip } from './VariantChip.tsx'
import { createLoomViewStore } from './view-store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Loom branching and fork-family copy. */
    loom: LoomKey
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** The Loom reading pane holding the Session it shows. */
    loom: unknown
  }
}

/** Browser services the Loom plugin reads. */
export const inject = ['remote', 'sessions', 'locale']

/** Services the Loom slot registrations wait for, including the mounted `loom` namespace. */
const UI_SERVICES = ['remote.loom', 'sessions', 'locale', 'slots', 'uiConversation', 'uiWorkspace']

/** Remote read of one step's request, supplied by the plugin that mounted the `loom` namespace. */
export type LoomRequestRead = LoomRequestInputs['read']

/**
 * Register the Loom dictionaries, sources, fork band, header chip, and view
 * tab on the calling fiber; disposing the fiber removes every registration and
 * releases every Session a reader retained.
 * @param ctx - Client context carrying the Session list, locale, slots, Conversation assembly, and navigation.
 * @param readRequest - the `loom.requestAt` Remote read.
 * @returns family sources, for callers that read families outside a slot.
 */
export function registerLoom(ctx: Context, readRequest: LoomRequestRead): LoomFamilySources {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-loom: dictionaries')
  const t = ctx.locale.bind(NS)
  const families = createLoomFamilySources({ sessions: ctx.sessions.list })
  const readerInputs: LoomReaderInputs = {
    retain: sessionId => ctx.sessions.retain(sessionId, { source: 'loom' }),
    chat: binding => ctx.uiConversation.binding(binding).target('chat'),
  }
  const readers = createLoomReaderSources(readerInputs)
  const requests = createLoomRequestSources({ read: readRequest })
  ctx.effect(() => () => {
    requests.dispose()
    readers.dispose()
    families.dispose()
  }, 'client-ui-loom: sources')

  const links: LoomLinkInjected = {
    keyedHooks: { loomFamily: key => families.source(key) },
    openSession: (sessionId) => { ctx.uiWorkspace.openSession(sessionId) },
    refreshProjection: (sessionId) => {
      ctx.sessions.refreshProjections(sessionId).catch((_error: unknown) => {
        // A failed read is recorded on the Session's projection snapshot; the Loom rows keep their partial values.
      })
    },
  }
  const view: LoomViewInjected = {
    ...links,
    keyedHooks: {
      loomFamily: key => families.source(key),
      loomReader: key => readers.source(key),
      loomRequest: key => requests.source(key),
    },
    loadOlder: (sessionId: SessionId) => {
      ctx.sessions.binding(sessionId)?.session.loadOlder().catch((_error: unknown) => {
        // A failed page leaves the window unchanged; the pane keeps offering the action.
      })
    },
  }
  ctx.slots.inject('conversation.chat.fork-cut', () => ctx.slots.register({
    name: 'conversation.chat.fork-cut',
    id: 'loom-fork-band',
    order: 0,
    locale: NS,
    inject: () => links,
  }, ForkBand))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'loom-variant',
    // Directly after the title, before Team navigation (-20) and the preset label (-10).
    order: -30,
    locale: NS,
    inject: () => links,
  }, VariantChip))
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: LOOM_VIEW_ID,
    // After Chat (0) and Trajectory (10).
    order: 20,
    locale: NS,
    label: () => t('view.loom'),
    store: createLoomViewStore(),
    inject: () => view,
  }, LoomView))
  return families
}

/**
 * Mount the experimental `loom` namespace without adding it to the stable API
 * Remotes, then register the Loom UI once its services exist and the tree's
 * shortcut reference rows once a shortcut registry exists.
 * @param ctx - Client runtime owning the Remote, registrations, and sources.
 * @param contribution - generated `loom` Remote definitions.
 * @returns disposer joining registration and Remote withdrawal.
 */
export async function mountLoom(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  // The mounted namespace is its own service, so only a fiber injecting `remote.loom` may read it.
  const ui = ctx.inject(UI_SERVICES, (inner) => {
    registerLoom(inner, (request, signal) => inner.remote.loom.requestAt(request, signal))
  })
  const keys = ctx.inject(['locale', 'shortcuts'], (inner) => { registerLoomTreeKeys(inner, inner.locale.bind(NS)) })
  try { await ui } catch (error) {
    await keys.dispose()
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await keys.dispose()
    await ui.dispose()
    await disposeRemote()
  }
}
