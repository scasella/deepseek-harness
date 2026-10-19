/** Source-safe lifecycle for the optional `loom` Remote and the Loom browser registrations. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { createLoomFamilySources, type LoomFamilySources } from './family.ts'
import { en, NS, zh, type LoomKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Loom branching and fork-family copy. */
    loom: LoomKey
  }
}

/** Browser services the Loom plugin reads. */
export const inject = ['remote', 'sessions', 'locale']

/**
 * Register the Loom dictionaries and the fork-family sources owned by the calling fiber.
 * @param ctx - Client context carrying the Session list and locale.
 * @returns family sources that later slot registrations bind as `useLoomFamily`.
 */
export function registerLoom(ctx: Context): LoomFamilySources {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-loom: dictionaries')
  const families = createLoomFamilySources({ sessions: ctx.sessions.list })
  ctx.effect(() => () => { families.dispose() }, 'client-ui-loom: family sources')
  return families
}

/**
 * Mount the experimental `loom` namespace without adding it to the stable API Remotes.
 * @param ctx - Client runtime owning the Remote, dictionaries, and family sources.
 * @param contribution - generated `loom` Remote definitions.
 * @returns disposer joining registration and Remote withdrawal.
 */
export async function mountLoom(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['sessions', 'locale'], (inner) => { registerLoom(inner) })
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
