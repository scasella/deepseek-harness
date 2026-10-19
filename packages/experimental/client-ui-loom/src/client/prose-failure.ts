/** Localized recovery guidance for typed prose refusals. */

/** Stable translated keys that need no interpolation. */
export type ProseFailureKey = 'weave.failed' | 'prose.unsupportedPrefix' | 'prose.unsupportedLogprobs' | 'prose.limits'
  | 'prose.prefix' | 'prose.route' | 'prose.busy' | 'prose.provider' | 'prose.cancelled' | 'prose.denied'

const REASONS: Readonly<Record<string, ProseFailureKey>> = {
  'unsupported-prefix': 'prose.unsupportedPrefix', 'unsupported-logprobs': 'prose.unsupportedLogprobs', limits: 'prose.limits',
  prefix: 'prose.prefix', route: 'prose.route', busy: 'prose.busy', provider: 'prose.provider', cancelled: 'prose.cancelled',
}

/**
 * Classify a Host refusal without presenting diagnostic English as product copy.
 * @param error - typed Remote failure; absent for a transport rejection.
 * @returns localized recovery guidance; unknown failures preserve the generic retry text.
 */
export function proseFailureKey(error?: { code: string; details?: unknown }): ProseFailureKey {
  if (error?.code === 'remote-access/denied' || error?.code === 'session/not-found') return 'prose.denied'
  if (error?.code === 'session/agent-busy') return 'prose.busy'
  const details = error?.details
  if (details !== null && typeof details === 'object' && 'reasonCode' in details && typeof details.reasonCode === 'string') {
    return REASONS[details.reasonCode] ?? 'weave.failed'
  }
  return 'weave.failed'
}
