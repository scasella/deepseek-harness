/**
 * View state of one Session's Loom tab: the mode, the Session the reading pane
 * shows, the branch point and branch Compare has picked, the tree rows the user
 * collapsed, the unsubmitted prose editor, and the row holding the tree's single tab stop. The registration
 * declares it, so the framework keeps one instance per Session and the state
 * survives switching between the Chat and Loom tabs.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LoomPrefixSpan } from '@deepseek-ai/dsh-experimental-loom/types'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Unsubmitted prose and controls retained across conversation panel remounts. */
export interface LoomProseDraft {
  text: string | null
  basis: readonly LoomPrefixSpan[] | null
  cursor: number | null
  n: number
  maxTokens: number
  temperature: number | null
  selection: ModelSelection | null
  requestSeq: SessionSeq | null
}

/** What the Loom tab shows: the reading pane with its tree, the comparison of branches at one cut, or prose. */
export type LoomViewMode = 'read' | 'compare' | 'weave'

/** One Loom tab's state. */
export interface LoomViewState {
  /** Which panel the tab shows. */
  mode: LoomViewMode
  /** Branch point Compare shows, by tree row id; null shows the point the selected Session belongs to. */
  point: string | null
  /** Branch Compare expanded for its diff and actions; null expands none. */
  picked: SessionId | null
  /** Session the reading pane shows; null shows the tab's own Session. */
  selected: SessionId | null
  /** Ids of collapsed tree rows; rows not listed are expanded. */
  collapsed: string[]
  /** Row holding the roving tab stop; null puts it on the selected row. */
  active: string | null
  /** Human editor contents and exact attribution basis, owned by this Session's view store. */
  prose: LoomProseDraft
}

/** The Loom tab's write set. */
type LoomViewActions = {
  mode: (draft: LoomViewState, mode: LoomViewMode) => void
  pointed: (draft: LoomViewState, pointId: string) => void
  picked: (draft: LoomViewState, sessionId: SessionId | null) => void
  selected: (draft: LoomViewState, sessionId: SessionId) => void
  toggled: (draft: LoomViewState, rowId: string) => void
  activated: (draft: LoomViewState, rowId: string) => void
  prose: (draft: LoomViewState, patch: Partial<LoomProseDraft>) => void
}

/**
 * Declare the Loom tab's store.
 * @returns the store handle the view registration declares.
 */
export function createLoomViewStore(): EngineStoreHandle<LoomViewState, LoomViewActions> {
  return defineStore({
    init: (): LoomViewState => ({ mode: 'read', point: null, picked: null, selected: null, collapsed: [], active: null,
      prose: { text: null, basis: null, cursor: null, n: 4, maxTokens: 70, temperature: null, selection: null, requestSeq: null } }),
    actions: {
      /**
       * Switch the tab's panel.
       * @param d - draft state.
       * @param mode - panel to show.
       */
      mode: (d, mode: LoomViewMode) => { d.mode = mode },
      /**
       * Compare another branch point; the expanded branch belongs to the old point, so it closes.
       * @param d - draft state.
       * @param pointId - tree row id of the point.
       */
      pointed: (d, pointId: string) => {
        d.point = pointId
        d.picked = null
      },
      /**
       * Expand one branch of the comparison, or none.
       * @param d - draft state.
       * @param sessionId - branch to expand, or null.
       */
      picked: (d, sessionId: SessionId | null) => { d.picked = sessionId },
      /**
       * Show one Session in the reading pane. Compare follows the selection, so the branch point and the picked
       * branch chosen for the previous Session are forgotten.
       * @param d - draft state.
       * @param sessionId - Session to read.
       */
      selected: (d, sessionId: SessionId) => {
        d.selected = sessionId
        d.point = null
        d.picked = null
      },
      /**
       * Collapse an expanded row or expand a collapsed one.
       * @param d - draft state.
       * @param rowId - tree row id.
       */
      toggled: (d, rowId: string) => {
        d.collapsed = d.collapsed.includes(rowId) ? d.collapsed.filter(id => id !== rowId) : [...d.collapsed, rowId]
      },
      /**
       * Move the tree's tab stop.
       * @param d - draft state.
       * @param rowId - tree row id.
       */
      activated: (d, rowId: string) => { d.active = rowId },
      /**
       * Retain an unsubmitted prose edit or generation control.
       * @param d - draft state.
       * @param patch - changed editor facts.
       */
      prose: (d, patch: Partial<LoomProseDraft>) => { Object.assign(d.prose, patch) },
    },
  })
}
