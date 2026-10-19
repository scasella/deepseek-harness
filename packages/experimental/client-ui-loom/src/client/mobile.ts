/** Viewport subscription shared by Loom controls that open a mobile bottom sheet. */
import { useEffect, useState } from 'react'

const QUERY = '(max-width: 480px)'

/**
 * Follow the phone-sized viewport without moving focus or opening the keyboard.
 * @returns true at 480 CSS pixels or less, false when viewport queries are unavailable.
 */
export function useLoomMobile(): boolean {
  const [mobile, setMobile] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const media = window.matchMedia(QUERY)
    const changed = (): void => { setMobile(media.matches) }
    changed()
    media.addEventListener('change', changed)
    return () => { media.removeEventListener('change', changed) }
  }, [])
  return mobile
}
