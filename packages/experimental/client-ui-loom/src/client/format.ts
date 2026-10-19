/** Locale-owned Loom number and cut readings shared by the band, the chip, the tree, and the reading pane. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'

/** Translate seat of the `loom` namespace, including the common vocabulary. */
export type LoomTranslate = TranslateNS<typeof NS>

/**
 * Compact token count in the Chat footer's reading: 517, 12.2K, 517K, 1.2M.
 * @param value - non-negative token count.
 * @param t - Loom translate seat.
 * @returns the compact count.
 */
export function compactTokens(value: number, t: LoomTranslate): string {
  if (value < 1_000) return String(value)
  const [divisor, key] = value < 1_000_000 ? [1_000, 'number.thousand'] as const : [1_000_000, 'number.million'] as const
  const scaled = value / divisor
  const shown = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10
  return t(key, { value: String(shown) })
}

/**
 * Exact count with the locale's digit grouping: 5,671.
 * @param value - non-negative integer.
 * @param t - Loom translate seat.
 * @returns the grouped digits.
 */
export function exactCount(value: number, t: LoomTranslate): string {
  const digits = String(value)
  const groups: string[] = []
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end))
  return groups.join(t('number.groupSeparator'))
}

/**
 * Name a cut by the turn it falls in or after.
 * @param cutTurn - turn of the last inherited `turn/end`, or undefined when no turn ended before the cut.
 * @param openedTurn - last turn opened before the cut, when known; a turn later than `cutTurn` was interrupted by the cut.
 * @param t - Loom translate seat.
 * @returns "during turn N" for a cut inside a turn, "after turn N", or the reading for a cut before any turn ended.
 */
export function cutReading(cutTurn: number | undefined, openedTurn: number | undefined, t: LoomTranslate): string {
  if (openedTurn !== undefined && openedTurn > (cutTurn ?? 0)) return t('band.during', { turn: openedTurn })
  return cutTurn === undefined ? t('band.afterStart') : t('band.after', { turn: cutTurn })
}

/**
 * Reduce a Markdown preview to readable plain text on one line: code fence
 * lines, heading, quote, and list markers, emphasis and strikethrough
 * delimiters, inline code backticks, and link syntax are removed, keeping the
 * text they mark, and whitespace
 * collapses to single spaces. Text inside inline code is kept verbatim, and the
 * backtick of a code span the preview bound cut open is dropped.
 * @param text - Markdown source of a bounded preview.
 * @returns the plain text.
 */
export function plainPreview(text: string): string {
  const lines = text
    // A fence marker and its language tag, also where a bounded preview joined the lines.
    .replace(/(?:```|~~~)[\w+-]*/gu, ' ')
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+)/gmu, '')
  return lines
    .split(/(`[^`\n]*`)/u)
    .map((part, index) => index % 2 === 1
      ? part.slice(1, -1)
      : part
        .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
        .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/gu, '$2')
        .replace(/\*(?=\S)(.+?)(?<=\S)\*/gu, '$1')
        .replace(/(?<!\w)_(?=\S)(.+?)(?<=\S)_(?!\w)/gu, '$1')
        // A preview bound can cut a code span open; its lone backtick is dropped.
        .replaceAll('`', ''))
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Pick the singular or plural form of a counted phrase.
 * @param count - counted value.
 * @returns the plural form suffix.
 */
export function plural(count: number): 'one' | 'other' {
  return count === 1 ? 'one' : 'other'
}
