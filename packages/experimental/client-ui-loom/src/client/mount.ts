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
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { BranchCaret } from './BranchCaret.tsx'
import { BranchForm } from './BranchForm.tsx'
import { createLoomBranching, type LoomBranchingInputs } from './branching.ts'
import { EditBranch } from './EditBranch.tsx'
import { createLoomFamilySources, type LoomFamilySources } from './family.ts'
import { ForkBand } from './ForkBand.tsx'
import type { LoomBranchingInjected, LoomLinkInjected } from './links.ts'
import { en, NS, zh, type LoomKey } from './locales.ts'
import { LOOM_VIEW_ID, LoomView, type LoomViewInjected } from './LoomView.tsx'
import { createLoomReaderSources, type LoomReaderInputs } from './reader.ts'
import { MarkGroup } from './MarkGroup.tsx'
import { RegenerateSplit } from './RegenerateSplit.tsx'
import { createLoomReads, loomCompareKey, type LoomReadInputs } from './reads.ts'
import { createLoomRequestSources, type LoomRequestInputs } from './requests.ts'
import { createLoomRoutes } from './routes.ts'
import { RunningStrip } from './RunningStrip.tsx'
import { registerLoomTreeKeys } from './shortcuts.ts'
import { VariantChip } from './VariantChip.tsx'
import { VariantPager } from './VariantPager.tsx'
import { createLoomViewStore } from './view-store.ts'
import { createLoomWorkspace, type LoomWorkspaceInputs } from './workspace.ts'
import { createMultiverseSearch } from './multiverse.ts'
import { MultiversePage, MultiverseIcon } from './MultiversePage.tsx'
import { createLoomProseReads, type LoomProseCalls } from './prose.ts'
import { CounterfactualAction } from './CounterfactualAction.tsx'
import { AutoloomCard } from './AutoloomCard.tsx'

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

/** The mounted `loom` Remote calls the slot entries use. */
export interface LoomRemoteCalls
  extends Pick<LoomBranchingInputs, 'branch' | 'cancel' | 'setStatus' | 'mark'>, LoomReadInputs,
  Pick<LoomWorkspaceInputs, 'adopt' | 'apply' | 'discard'>, LoomProseCalls {
  /** `loom.requestAt`. */
  readonly requestAt: LoomRequestRead
}

/**
 * Register the Loom dictionaries, sources, branching state, workspace verbs,
 * fork band, header chip, turn-tail actions, Edit & branch, dock entries, and
 * view tab on the calling fiber, and attach the route list while the `session`
 * Remote is mounted; disposing the fiber removes every registration, releases
 * every Session a reader retained, closes the compare, diff, and estimate
 * sources, and drops the branching state.
 * @param ctx - Client context carrying the Session list, locale, slots, Conversation assembly, and navigation.
 * @param calls - the `loom` Remote calls.
 * @returns family sources, for callers that read families outside a slot.
 */
export function registerLoom(ctx: Context, calls: LoomRemoteCalls): LoomFamilySources {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-loom: dictionaries')
  const t = ctx.locale.bind(NS)
  const families = createLoomFamilySources({ sessions: ctx.sessions.list })
  const readerInputs: LoomReaderInputs = {
    retain: sessionId => ctx.sessions.retain(sessionId, { source: 'loom' }),
    chat: binding => ctx.uiConversation.binding(binding).target('chat'),
  }
  const readers = createLoomReaderSources(readerInputs)
  const prose = createLoomProseReads(calls)
  const multiverseSearch = createMultiverseSearch((...args) => ctx.sessions.search(...args))
  const requests = createLoomRequestSources({ read: calls.requestAt })
  const branching = createLoomBranching({
    branch: calls.branch,
    cancel: calls.cancel,
    setStatus: calls.setStatus,
    mark: calls.mark,
    refreshProjection: sessionId => ctx.sessions.refreshProjections(sessionId),
    openSession: (sessionId) => { ctx.uiWorkspace.openSession(sessionId) },
  })
  const routes = createLoomRoutes()
  const reads = createLoomReads({ compare: calls.compare, diff: calls.diff, estimate: calls.estimate })
  const workspace = createLoomWorkspace({
    adopt: calls.adopt,
    apply: calls.apply,
    discard: calls.discard,
    refreshProjection: sessionId => ctx.sessions.refreshProjections(sessionId),
  })
  ctx.effect(() => () => {
    workspace.dispose()
    prose.dispose()
    multiverseSearch.dispose()
    reads.dispose()
    branching.dispose()
    requests.dispose()
    readers.dispose()
    families.dispose()
  }, 'client-ui-loom: sources')
  // The route pickers appear only while the stable `session` Remote is mounted.
  ctx.inject(['remote.session'], (scope) => {
    scope.effect(() => routes.attach(() => scope.remote.session.modelCatalog()), 'client-ui-loom: route list')
  })

  const links: LoomLinkInjected = {
    keyedHooks: { loomFamily: key => families.source(key) },
    openSession: (sessionId) => { ctx.uiWorkspace.openSession(sessionId) },
    refreshProjection: (sessionId) => {
      ctx.sessions.refreshProjections(sessionId).catch((_error: unknown) => {
        // A failed read is recorded on the Session's projection snapshot; the Loom rows keep their partial values.
      })
    },
  }
  const branchingFace: LoomBranchingInjected = {
    ...links,
    keyedHooks: { loomFamily: key => families.source(key), loomEstimate: key => reads.estimate.source(key) },
    hooks: { loomBranching: branching.state, loomRoutes: routes.state },
    startBranches: (draft, options) => branching.start(draft, options),
    cancelBranches: (setId, indices) => branching.cancel(setId, indices),
    adoptSet: (set) => { branching.adopt(set) },
    refreshSet: (setId) => { branching.refresh(setId) },
    dismissSet: (setId) => { branching.dismiss(setId) },
    setMark: (sessionId, mark) => branching.setMark(sessionId, mark),
    openForm: (owner, target) => { branching.openForm(owner, target) },
    editForm: (owner, edit) => { branching.editForm(owner, edit) },
    closeForm: (owner) => { branching.closeForm(owner) },
    submitForm: owner => branching.submitForm(owner),
    loadRoutes: () => { routes.load() },
  }
  const view: LoomViewInjected = {
    ...branchingFace,
    keyedHooks: {
      ...branchingFace.keyedHooks,
      loomReader: key => readers.source(key),
      loomRequest: key => requests.source(key),
      loomCompare: key => reads.compare.source(key),
      loomDiff: key => reads.diff.source(key),
      loomWeave: key => prose.source(key),
    },
    weave: calls.weave,
    choose: calls.choose,
    probe: calls.probe,
    exportLoom: calls.export,
    refreshWeave: (sessionId) => { prose.refresh(sessionId) },
    refreshCompare: (sessionId) => { reads.compare.refresh(loomCompareKey(sessionId)) },
    adoptBranch: sessionId => workspace.adopt(sessionId),
    applyBranch: sessionId => workspace.apply(sessionId),
    discardBranch: sessionId => workspace.discard(sessionId),
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
  const tailEntries = [
    // The caret sits directly after Branch; each later entry opens its own group with a rule.
    { id: 'loom-branch-caret', order: 0, component: BranchCaret },
    { id: 'loom-pager', order: 10, component: VariantPager },
    { id: 'loom-regenerate', order: 20, component: RegenerateSplit },
    { id: 'loom-marks', order: 30, component: MarkGroup },
  ] as const
  for (const entry of tailEntries) {
    ctx.slots.inject('conversation.chat.assistant-actions.after', () => ctx.slots.register({
      name: 'conversation.chat.assistant-actions.after',
      id: entry.id,
      order: entry.order,
      locale: NS,
      inject: () => branchingFace,
    }, entry.component))
  }
  ctx.slots.inject('conversation.chat.user-actions', () => ctx.slots.register({
    name: 'conversation.chat.user-actions',
    id: 'loom-edit-branch',
    order: 10,
    locale: NS,
    inject: () => branchingFace,
  }, EditBranch))
  ctx.slots.inject('tool.call.actions', () => ctx.slots.register({
    name: 'tool.call.actions', id: 'loom-counterfactual', locale: NS,
    inject: () => ({ counterfactual: calls.counterfactual, openSession: links.openSession }),
  }, CounterfactualAction))
  for (const key of ['loom_expand', 'loom_wait', 'loom_read', 'loom_cull', 'loom_keep']) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', key, locale: NS, inject: () => ({ openSession: links.openSession }),
    }, AutoloomCard))
  }
  // Between the Goal card (10) and the queue panel (20), which stays attached to the composer card.
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'loom-running',
    order: 14,
    locale: NS,
    inject: () => branchingFace,
  }, RunningStrip))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'loom-branch-form',
    order: 16,
    locale: NS,
    inject: () => branchingFace,
  }, BranchForm))
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
  const multiversePanel = brandString<MainPanelId>('loom-multiverse')
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: multiversePanel, locale: NS,
    inject: () => ({
      keyedHooks: { loomFamilySearch: (key: string) => multiverseSearch.source(key) },
      openSession: links.openSession,
      retrySearch: (key: string) => { multiverseSearch.refresh(key) },
    }),
  }, MultiversePage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: multiversePanel, order: 20, locale: NS,
    label: () => t('multiverse.title'),
  }, MultiverseIcon))
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
    const loom = inner.remote.loom
    registerLoom(inner, {
      requestAt: (request, signal) => loom.requestAt(request, signal),
      branch: request => loom.branch(request),
      cancel: request => loom.cancel(request),
      setStatus: request => loom.setStatus(request),
      mark: request => loom.mark(request),
      compare: request => loom.compare(request),
      diff: request => loom.diff(request),
      estimate: request => loom.estimate(request),
      adopt: request => loom.adopt(request),
      apply: request => loom.apply(request),
      discard: request => loom.discard(request),
      weave: request => loom.weave(request),
      weaveState: request => loom.weaveState(request),
      choose: request => loom.choose(request),
      probe: request => loom.probe(request),
      export: request => loom.export(request),
      counterfactual: request => loom.counterfactual(request),
    })
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
