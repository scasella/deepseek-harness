/**
 * View state of one Session's Loom tab: the Session the reading pane shows,
 * the tree rows the user collapsed, and the row holding the tree's single tab
 * stop. The registration declares it, so the framework keeps one instance per
 * Session and the state survives switching between the Chat and Loom tabs.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One Loom tab's state. */
export interface LoomViewState {
  /** Session the reading pane shows; null shows the tab's own Session. */
  selected: SessionId | null
  /** Ids of collapsed tree rows; rows not listed are expanded. */
  collapsed: string[]
  /** Row holding the roving tab stop; null puts it on the selected row. */
  active: string | null
}

/** The Loom tab's write set. */
type LoomViewActions = {
  selected: (draft: LoomViewState, sessionId: SessionId) => void
  toggled: (draft: LoomViewState, rowId: string) => void
  activated: (draft: LoomViewState, rowId: string) => void
}

/**
 * Declare the Loom tab's store.
 * @returns the store handle the view registration declares.
 */
export function createLoomViewStore(): EngineStoreHandle<LoomViewState, LoomViewActions> {
  return defineStore({
    init: (): LoomViewState => ({ selected: null, collapsed: [], active: null }),
    actions: {
      /**
       * Show one Session in the reading pane.
       * @param d - draft state.
       * @param sessionId - Session to read.
       */
      selected: (d, sessionId: SessionId) => { d.selected = sessionId },
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
    },
  })
}
