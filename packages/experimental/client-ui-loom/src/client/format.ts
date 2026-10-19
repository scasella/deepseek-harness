/** Locale-owned Loom number, cut, route, and failure readings shared by the Loom entries. */
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { LoomIsolationUnavailableReason } from '@deepseek-ai/dsh-experimental-loom/types'
import { LOOM_UNAVAILABLE, type LoomFailure } from './branching.ts'
import type { LoomKey, NS } from './locales.ts'
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
  return listText(rows.map(String), t)
}

/**
 * List items the way the dictionary joins them.
 * @param items - the items, at least one.
 * @param t - Loom translate seat.
 * @returns the items joined by the list separator, with the last joiner before the final one.
 */
export function listText(items: readonly string[], t: LoomTranslate): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(t('form.rowsSep'))}${t('form.rowsLast')}${String(items.at(-1))}`
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

/**
 * Name a cut by the turn it falls in or after, as the tree's branch-point rows and the Compare point picker do.
 * @param cutTurn - turn of the last inherited `turn/end`, or undefined when no turn ended before the cut.
 * @param openedTurn - last turn opened before the cut, when known; a turn later than `cutTurn` was interrupted by the cut.
 * @param t - Loom translate seat.
 * @returns "During turn N", "After turn N", or the reading for a cut before any turn ended.
 */
export function pointReading(cutTurn: number | undefined, openedTurn: number | undefined, t: LoomTranslate): string {
  if (openedTurn !== undefined && openedTurn > (cutTurn ?? 0)) return t('tree.pointDuring', { turn: openedTurn })
  return cutTurn === undefined ? t('tree.pointStart') : t('tree.pointAfter', { turn: cutTurn })
}

/**
 * Name a US-dollar amount: two decimals from one dollar up, three below, and a floor reading under a tenth of a cent.
 * @param amount - non-negative dollars.
 * @param t - Loom translate seat.
 * @returns the amount.
 */
export function usdText(amount: number, t: LoomTranslate): string {
  if (amount > 0 && amount < 0.001) return t('price.below')
  const value = amount >= 1 ? amount.toFixed(2) : amount === 0 ? '0' : amount.toFixed(3)
  return t('price.usd', { value })
}

/**
 * Name a range once when its ends read the same.
 * @param low - lower end.
 * @param high - upper end.
 * @param format - how one end reads.
 * @param t - Loom translate seat.
 * @returns "low–high", or the single reading.
 */
export function rangeText(low: number, high: number, format: (value: number) => string, t: LoomTranslate): string {
  const first = format(low)
  const last = format(high)
  return first === last ? first : t('price.range', { low: first, high: last })
}

/**
 * Name a wall-clock span in whole seconds, or minutes and seconds from one minute up.
 * @param ms - non-negative milliseconds.
 * @param t - Loom translate seat.
 * @returns the span.
 */
export function durationText(ms: number, t: LoomTranslate): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60
    ? t('time.seconds', { value: seconds })
    : t('time.minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })
}

/** Paths a failure names before the rest collapse into a count. */
const PATHS_SHOWN = 3

/**
 * List the paths a failure names.
 * @param paths - the paths.
 * @param t - Loom translate seat.
 * @returns the first few paths, and how many more there are.
 */
export function pathsText(paths: readonly string[], t: LoomTranslate): string {
  const shown = paths.slice(0, PATHS_SHOWN).join(t('form.rowsSep'))
  return paths.length > PATHS_SHOWN ? t('failure.pathsMore', { paths: shown, count: paths.length - PATHS_SHOWN }) : shown
}

/** Copy key of each reason the Host refuses worktree isolation. */
const ISOLATION_REASONS: Readonly<Record<LoomIsolationUnavailableReason, LoomKey>> = {
  'service-unavailable': 'isolation.reason.serviceUnavailable',
  'read-only': 'isolation.reason.readOnly',
  'no-repository': 'isolation.reason.noRepository',
  'subdirectory': 'isolation.reason.subdirectory',
  'linked-checkout': 'isolation.reason.linkedCheckout',
}

/** The reasons by their wire spelling, so a spelling this client does not know finds no entry. */
const ISOLATION_REASON_KEYS: ReadonlyMap<string, LoomKey> = new Map(Object.entries(ISOLATION_REASONS))

/**
 * Name why worktree isolation is unavailable.
 * @param reason - the Host's reason.
 * @param t - Loom translate seat.
 * @returns a localized reason; a reason a newer Host names appears verbatim.
 */
export function isolationReasonText(reason: LoomIsolationUnavailableReason, t: LoomTranslate): string {
  const key = ISOLATION_REASON_KEYS.get(reason)
  return key === undefined ? reason : t(key)
}

/** Copy key of each reason a branch has no worktree. */
const WORKTREE_REASONS = {
  shared: 'failure.worktree.shared',
  removed: 'failure.worktree.removed',
  missing: 'failure.worktree.missing',
} as const satisfies Record<NonNullable<LoomFailure['worktreeReason']>, LoomKey>

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
    case 'loom/isolation-unavailable':
      return failure.isolationReason === undefined
        ? t('failure.other', { code: failure.code })
        : t('failure.isolation', { reason: isolationReasonText(failure.isolationReason, t) })
    case 'loom/not-a-fork': return t('failure.notFork')
    case 'loom/apply-dirty': return t('failure.applyDirty', { paths: pathsText(failure.paths ?? [], t) })
    case 'loom/apply-conflict':
      return failure.paths === undefined || failure.paths.length === 0
        ? t('failure.applyConflictNoPaths')
        : t('failure.applyConflict', { paths: pathsText(failure.paths, t) })
    case 'loom/apply-not-isolated': return t('failure.applyNotIsolated')
    case 'loom/apply-too-large': return t('failure.applyTooLarge', { limit: failure.limit ?? 0 })
    case 'loom/worktree-unavailable':
      return failure.worktreeReason === undefined ? t('failure.other', { code: failure.code }) : t(WORKTREE_REASONS[failure.worktreeReason])
    case 'loom/diff-unavailable': return t('failure.diffUnavailable')
    case 'loom/worktree-cleanup-failed': return t('failure.cleanupFailed', { paths: pathsText(failure.paths ?? [], t) })
    case 'loom/adopt-incomplete':
      return t(`failure.adoptIncomplete.${plural(failure.remaining ?? 0)}`, { count: failure.remaining ?? 0 })
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
