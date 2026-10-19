/** Inject face shared by the Loom entries that read fork families and open Sessions. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LoomFamilyState } from './family.ts'

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
