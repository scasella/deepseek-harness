/**
 * React-free fork-family sources keyed by Session id. Each source derives the
 * family from the client Session list, which the Host keeps current, so a
 * slot registration can bind it as `useLoomFamily(sessionId)` through its
 * `keyedHooks` compartment.
 */
import { notifySubscribers, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { forkFamily, type LoomFamilyRow } from '@deepseek-ai/dsh-experimental-loom/family'
import type { LoomFamily } from '@deepseek-ai/dsh-experimental-loom/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { keyedSourceRegistry, type KeyedLifecycle } from './keyed-sources.ts'

/** Current family of one Session as the browser knows it. */
export type LoomFamilyState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly family: LoomFamily }
  | { readonly status: 'unlisted' }

/** Inputs of the family sources, supplied by the owning plugin. */
export interface LoomFamilyInputs {
  /** Client Session list carrying membership, fork links, creation hints, and live status. */
  readonly sessions: ObservableSnapshot<SessionListState>
}

/** Keyed fork-family sources owned by one plugin fiber. */
export interface LoomFamilySources {
  /**
   * Return the source of one Session's family. The source follows the
   * Session list from its first subscriber until its last unsubscribe, which
   * also drops it, so a later call returns a fresh source.
   * @param key - Session id.
   * @returns the source for that Session, stable while observed.
   */
  source(key: string): ObservableSnapshot<LoomFamilyState>
  /** Drop every list subscription. */
  dispose(): void
}

const LOADING: LoomFamilyState = Object.freeze({ status: 'loading' })
const UNLISTED: LoomFamilyState = Object.freeze({ status: 'unlisted' })

/**
 * Map one listed client row into the facts a fork family reads.
 * @param summary - client row of a Host-listed Session.
 * @returns the row, with the parent link dropped for a subagent child.
 */
function familyRow(summary: SessionSummary): LoomFamilyRow {
  const createdAt = summary.projectionValues?.forkLineage?.createdAt
  return {
    sessionId: summary.id,
    ...summary.origin === 'subagent' || summary.parentId === undefined ? {} : { forkParentId: summary.parentId },
    ...createdAt === undefined ? {} : { createdAt },
    updatedAt: summary.updatedAt,
    running: summary.running,
    blank: summary.blank,
  }
}

/**
 * Create fork-family sources over the client Session list.
 * @param inputs - Session list.
 * @returns keyed sources; the caller disposes them with its fiber.
 */
export function createLoomFamilySources(inputs: LoomFamilyInputs): LoomFamilySources {
  // Every observed source reads the same snapshot, so the rows are mapped once per snapshot.
  let mapped: { readonly list: SessionListState; readonly rows: readonly LoomFamilyRow[] } | undefined
  const rowsOf = (list: SessionListState): readonly LoomFamilyRow[] => {
    if (mapped?.list !== list) {
      // Only `ids` expresses Host-list membership; `byId` also retains subagent fallbacks.
      const rows = list.ids.flatMap((id) => {
        const summary = list.byId[id]
        return summary === undefined ? [] : [familyRow(summary)]
      })
      mapped = { list, rows }
    }
    return mapped.rows
  }
  const sources = keyedSourceRegistry((key, lifecycle) => new FamilySource(SessionId(key), inputs.sessions, rowsOf, lifecycle))
  return {
    source: key => sources.get(key),
    dispose() {
      sources.dispose()
      mapped = undefined
    },
  }
}

/** One Session's family, derived from each ready list snapshot while observed. */
class FamilySource implements ObservableSnapshot<LoomFamilyState> {
  private readonly listeners = new Set<() => void>()
  private state: LoomFamilyState = LOADING
  private unsubscribeList: (() => void) | undefined

  constructor(
    private readonly sessionId: SessionId,
    private readonly sessions: ObservableSnapshot<SessionListState>,
    private readonly rowsOf: (list: SessionListState) => readonly LoomFamilyRow[],
    private readonly lifecycle: KeyedLifecycle,
  ) {}

  getSnapshot(): LoomFamilyState { return this.state }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      this.lifecycle.active()
      this.unsubscribeList = this.sessions.subscribe(() => { this.derive() })
      this.derive()
    }
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return
      this.close()
      this.lifecycle.idle()
    }
  }

  close(): void {
    this.listeners.clear()
    this.unsubscribeList?.()
    this.unsubscribeList = undefined
  }

  /** Recompute from the current list; a pending list keeps the current state. */
  private derive(): void {
    const list = this.sessions.getSnapshot()
    if (list.phase !== 'ready') return
    const previous = this.state.status === 'ready' ? this.state.family : undefined
    const family = forkFamily(this.rowsOf(list), this.sessionId, previous)
    if (family === undefined) {
      this.publish(UNLISTED)
      return
    }
    if (family !== previous) this.publish({ status: 'ready', family })
  }

  private publish(state: LoomFamilyState): void {
    if (state === this.state) return
    this.state = state
    notifySubscribers(this.listeners, '[client-ui-loom] family')
  }
}
