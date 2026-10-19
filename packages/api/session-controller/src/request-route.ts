/** Model routes recorded by `request/header` events, and the route a fork cut leaves its child. */

import type { ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent'
import type { EpochHeader, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'

/**
 * Read the conversation route one request header recorded. An effort the
 * adapter defaulted is not a conversation choice, so it is left out: restoring
 * it as one would make an unchanged default read as a request change.
 * @param header - logged request header.
 * @returns the provider, model, and explicitly chosen effort.
 */
export function headerRoute(header: EpochHeader): AgentModelSelection {
  const { config } = header
  return {
    provider: config.provider,
    model: config.model,
    ...config.reasoningEffort === undefined || header.adapterDefaults?.reasoningEffort === true
      ? {}
      : { reasoningEffort: config.reasoningEffort },
  }
}

/**
 * Route of the source's first logged request when a fork cut precedes it. A
 * child whose inherited prefix holds no `request/header` and no
 * `model/selection` has no route of its own and would run on the deployment
 * default; the source's first header is the route its first turn ran on. A
 * prefix holding a header or a pick already routes the child: on the last
 * inherited header, or on a pick that no inherited header consumed.
 * @param events - complete source log with contiguous seqs from zero.
 * @param boundary - inclusive fork boundary.
 * @returns the first header's route, or undefined when the prefix holds a
 *   header or a pick, or the source logged no header.
 */
export function firstRequestRoute(events: readonly SessionEvent[], boundary: SessionSeq): AgentModelSelection | undefined {
  const routed = events.some(event => event.seq <= boundary
    && (event.type === 'request/header' || event.type === 'model/selection'))
  if (routed) return undefined
  const first = events.find((event): event is SessionEvent<'request/header'> => event.type === 'request/header')
  return first === undefined ? undefined : headerRoute(first.data.header)
}
