/** Locale-owned Loom number, cut, route, and failure readings shared by the Loom entries. */
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { LOOM_UNAVAILABLE, type LoomFailure } from './branching.ts'
import type { NS } from './locales.ts'
import type { LoomRouteOption } from './routes.ts'

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

/**
 * Name a route the way the composer's model picker does: the catalog's model
 * display name and the effort's display name. A route the catalog does not
 * list, or has not loaded, appears as its raw ids.
 * @param route - the route.
 * @param options - the loaded route list, empty before it loads.
 * @param t - Loom translate seat.
 * @returns "model · effort", or the raw ids from {@link routeText}.
 */
export function routeLabel(route: ModelSelection, options: readonly LoomRouteOption[], t: LoomTranslate): string {
  const option = options.find(candidate => candidate.selection.provider === route.provider && candidate.selection.model === route.model)
  if (option === undefined) return routeText(route, t)
  const effort = route.reasoningEffort === undefined
    ? undefined
    : option.efforts.find(level => level.id === route.reasoningEffort)?.name ?? route.reasoningEffort
  return [option.modelName, effort].filter(part => part !== undefined).join(t('sep'))
}

/**
 * List one-based row positions the way the dictionary joins them.
 * @param rows - the positions, at least one.
 * @param t - Loom translate seat.
 * @returns the positions joined by the list separator, with the last joiner before the final one.
 */
export function rowsText(rows: readonly number[], t: LoomTranslate): string {
  const last = rows.at(-1)
  return rows.length < 2 ? rows.join('') : `${rows.slice(0, -1).join(t('form.rowsSep'))}${t('form.rowsLast')}${String(last)}`
}

/**
 * Name a route as provider, model, and effort.
 * @param route - the route.
 * @param t - Loom translate seat.
 * @returns "provider · model · effort", without the effort when the route names none.
 */
export function routeText(route: ModelSelection, t: LoomTranslate): string {
  return [route.provider, route.model, route.reasoningEffort].filter(part => part !== undefined).join(t('sep'))
}

/**
 * Name the share of prompt input served from cache, rounded down to a whole percent so a partial hit never reads 100%.
 * @param cached - cached prompt input.
 * @param input - all prompt input, cached included.
 * @returns the percent, or undefined without prompt input.
 */
export function cachePercent(cached: number, input: number): number | undefined {
  return input <= 0 ? undefined : Math.floor((cached / input) * 100)
}

/** Copy key of each `loom/turn-unavailable` reason. */
const TURN_REASONS = {
  'not-found': 'failure.turn.notFound',
  'not-ended': 'failure.turn.notEnded',
  'not-user-opened': 'failure.turn.notUserOpened',
  'no-cut': 'failure.turn.noCut',
} as const

/**
 * Describe a refused or failed Loom call.
 * @param failure - the failure facts.
 * @param t - Loom translate seat.
 * @returns the localized sentence; an unknown code appears verbatim.
 */
export function failureText(failure: LoomFailure, t: LoomTranslate): string {
  if (failure.unknownOutcome) return t('failure.unknownOutcome')
  switch (failure.code) {
    case LOOM_UNAVAILABLE: return t('failure.unavailable')
    case 'loom/empty-line': return t('failure.emptyLine', { index: (failure.line ?? 0) + 1 })
    case 'loom/too-many-branches': return t('failure.tooMany', { limit: failure.limit ?? 0 })
    case 'loom/set-not-found': return t('failure.setNotFound')
    case 'remote-access/denied': return t('failure.denied')
    case 'session/not-found': return t('saw.notFound')
    case 'session/fork-unavailable': return t('failure.forkUnavailable')
    case 'session/workspace-attach-failed': return t('failure.attachFailed')
    case 'session/model-unavailable': return t('failure.modelUnavailable')
    case 'loom/turn-unavailable':
      return failure.reason === undefined ? t('failure.other', { code: failure.code }) : t(TURN_REASONS[failure.reason])
    default: return t('failure.other', { code: failure.code })
  }
}
