/** Whether the primary pointer can hover, for tooltips that only name an action. */
import { useEffect, useState } from 'react'

const QUERY = '(hover: hover)'

/**
 * Read whether the device hovers, following later changes such as a docked tablet.
 * @returns true on a hover-capable device; false without one or without `matchMedia`.
 */
export function useHoverCapable(): boolean {
  const [hover, setHover] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const media = window.matchMedia(QUERY)
    const changed = (): void => { setHover(media.matches) }
    changed()
    media.addEventListener('change', changed)
    return () => { media.removeEventListener('change', changed) }
  }, [])
  return hover
}
