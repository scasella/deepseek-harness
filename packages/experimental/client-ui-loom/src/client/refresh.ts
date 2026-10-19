/** Component-local request for projections that have not arrived. */
import { useEffect, useRef } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Ask once per mounted component for each listed Session's projections, so a
 * Session whose values never arrive is not requested on every list change.
 * @param ids - Sessions missing a needed projection value.
 * @param refresh - injected projection refresh.
 */
export function useRefreshOnce(ids: readonly SessionId[], refresh: (sessionId: SessionId) => void): void {
  const requested = useRef(new Set<SessionId>())
  useEffect(() => {
    for (const id of ids) {
      if (requested.current.has(id)) continue
      requested.current.add(id)
      refresh(id)
    }
  }, [ids, refresh])
}
