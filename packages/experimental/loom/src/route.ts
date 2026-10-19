/** Provider routes read from a Session log: what a request header names and what the next request takes. */
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller'
import type { EpochHeader, SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Route a request header names: its provider and model, and its reasoning
 * effort unless the adapter supplied that effort instead of a caller.
 * @param header - the header of a logged request.
 * @returns the route as a model selection.
 */
export function routeOfHeader(header: EpochHeader): ModelSelection {
  const { provider, model, reasoningEffort } = header.config
  return {
    provider,
    model,
    ...reasoningEffort === undefined || header.adapterDefaults?.reasoningEffort === true ? {} : { reasoningEffort },
  }
}

/**
 * Whether two routes are the same provider, model, and chosen reasoning effort.
 * @param left - one route.
 * @param right - the other.
 * @returns whether they match.
 */
export function sameRoute(left: ModelSelection, right: ModelSelection): boolean {
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}

/**
 * Route the latest request at or before a seq was sent on.
 * @param events - complete log.
 * @param seq - last event the read may use.
 * @returns the route of the latest `request/header`, or undefined when none precedes the seq.
 */
export function headerRouteAt(events: readonly SessionEvent[], seq: number): ModelSelection | undefined {
  const header = events.slice(0, seq + 1).findLast((event): event is SessionEvent<'request/header'> => event.type === 'request/header')
  return header === undefined ? undefined : routeOfHeader(header.data.header)
}

/**
 * Route the next request after a seq takes: the latest of the `request/header`
 * and the `model/selection` pick at or before it, because a pick the log holds
 * after the last header is not consumed yet.
 * @param events - complete log.
 * @param seq - last event the read may use.
 * @returns the route, or undefined when neither event precedes the seq.
 */
export function nextRouteAt(events: readonly SessionEvent[], seq: number): ModelSelection | undefined {
  const latest = events.slice(0, seq + 1).findLast((event): event is SessionEvent<'request/header'> | SessionEvent<'model/selection'> =>
    event.type === 'request/header' || event.type === 'model/selection')
  if (latest === undefined) return undefined
  return latest.type === 'request/header' ? routeOfHeader(latest.data.header) : latest.data
}

/**
 * Narrow an event to a request settlement.
 * @param event - any logged event.
 * @returns whether the event settled one model request.
 */
export function isSettlement(event: SessionEvent): event is SessionEvent<'assistant/message'> | SessionEvent<'assistant/attempt'> {
  return event.type === 'assistant/message' || event.type === 'assistant/attempt'
}

/**
 * The one provider and model every request a Session sent itself, after its
 * fork cut, was sent on.
 * @param events - complete log.
 * @param inheritedEventCount - events the Session inherited at its fork.
 * @returns the route, or undefined when the Session sent no request, two own requests took different routes, or an
 *   own request has no `request/header` before it.
 */
export function ownRoute(
  events: readonly SessionEvent[],
  inheritedEventCount: number,
): { readonly provider: string; readonly model: string } | undefined {
  let current = headerRouteAt(events, inheritedEventCount - 1)
  let route: { readonly provider: string; readonly model: string } | undefined
  for (const event of events.slice(inheritedEventCount)) {
    if (event.type === 'request/header') current = routeOfHeader(event.data.header)
    if (!isSettlement(event)) continue
    if (current === undefined) return undefined
    const { provider, model } = current
    if (route !== undefined && (route.provider !== provider || route.model !== model)) return undefined
    route = { provider, model }
  }
  return route
}
