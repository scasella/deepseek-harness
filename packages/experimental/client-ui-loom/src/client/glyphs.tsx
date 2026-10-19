/**
 * Keep and Set aside glyphs of the private marks, drawn on the 16-unit icon
 * grid with a 1-unit stroke in the current color. They await designer approval.
 */

/** Props of a mark glyph. */
interface GlyphProps {
  /** Rendered edge length in CSS pixels. */
  readonly size?: number
  readonly className?: string
}

/**
 * Bookmark: a Session the user keeps.
 * @param props - size and class.
 * @returns the glyph.
 */
export function KeepGlyph({ size = 16, className }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true" className={className}>
      <path d="M4 2.5C4 1.94772 4.44772 1.5 5 1.5H11C11.5523 1.5 12 1.94772 12 2.5V14.2L8 11.3L4 14.2V2.5Z" stroke="currentColor" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Card moving into an open tray: a Session the user set aside, kept but out of the way.
 * @param props - size and class.
 * @returns the glyph.
 */
export function SetAsideGlyph({ size = 16, className }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" strokeWidth={1} aria-hidden="true" className={className}>
      <rect x="4.5" y="1.5" width="7" height="5" rx="1" stroke="currentColor" />
      <path d="M8 7.5V10.5" stroke="currentColor" />
      <path d="M6.5 9L8 10.5L9.5 9" stroke="currentColor" />
      <path d="M1.5 9.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V9.5" stroke="currentColor" />
    </svg>
  )
}
