/** Inject faces shared by the Loom entries that read fork families, open Sessions, and branch them. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LoomBranching, LoomBranchingState } from './branching.ts'
import type { LoomFamilyState } from './family.ts'
import type { LoomReadState } from './read-sources.ts'
import type { LoomRoutesState } from './routes.ts'
import type { LoomEstimateValue } from '@deepseek-ai/dsh-experimental-loom/types'

/** Family hook source and navigation callbacks the band, the header chip, and the view receive. */
export interface LoomLinkInjected {
  /** Fork-family sources keyed by Session id, bound as `useLoomFamily(sessionId)`. */
  readonly keyedHooks: { readonly loomFamily: (key: string) => ObservableSnapshot<LoomFamilyState> }
  /**
   * Open a Session in the main view.
   * @param sessionId - Session to open.
   */
  readonly openSession: (sessionId: SessionId) => void
  /**
   * Ask the Host for a Session's projections when a needed value has not arrived.
   * @param sessionId - Session to refresh.
   */
  readonly refreshProjection: (sessionId: SessionId) => void
}

/** Branching state, route list, and verbs the turn-tail actions, dock entries, user-message editor, and view receive. */
export interface LoomBranchingInjected extends LoomLinkInjected {
  readonly keyedHooks: LoomLinkInjected['keyedHooks'] & {
    /** Cost estimates keyed by {@link loomEstimateKey}, bound as `useLoomEstimate(key)`. */
    readonly loomEstimate: (key: string) => ObservableSnapshot<LoomReadState<LoomEstimateValue>>
  }
  readonly hooks: {
    /** Branch sets, forms, and marks being saved, bound as `useLoomBranching(selector)`. */
    readonly loomBranching: ObservableSnapshot<LoomBranchingState>
    /** Route list of the pickers, bound as `useLoomRoutes(selector)`. */
    readonly loomRoutes: ObservableSnapshot<LoomRoutesState>
  }
  /** Start a branch set; see {@link LoomBranching.start}. */
  readonly startBranches: LoomBranching['start']
  /** Withdraw queued children; see {@link LoomBranching.cancel}. */
  readonly cancelBranches: LoomBranching['cancel']
  /** Follow a set found running; see {@link LoomBranching.adopt}. */
  readonly adoptSet: LoomBranching['adopt']
  /** Read a followed set's status again; see {@link LoomBranching.refresh}. */
  readonly refreshSet: LoomBranching['refresh']
  /** Stop following a set; see {@link LoomBranching.dismiss}. */
  readonly dismissSet: LoomBranching['dismiss']
  /** Save a private mark; see {@link LoomBranching.setMark}. */
  readonly setMark: LoomBranching['setMark']
  /** Open the Branch ×N form; see {@link LoomBranching.openForm}. */
  readonly openForm: LoomBranching['openForm']
  /** Change a form's draft; see {@link LoomBranching.editForm}. */
  readonly editForm: LoomBranching['editForm']
  /** Close a form; see {@link LoomBranching.closeForm}. */
  readonly closeForm: LoomBranching['closeForm']
  /** Start a form's branches; see {@link LoomBranching.submitForm}. */
  readonly submitForm: LoomBranching['submitForm']
  /** Read the route list once a picker needs it; nothing happens while detached or loaded. */
  readonly loadRoutes: () => void
}
