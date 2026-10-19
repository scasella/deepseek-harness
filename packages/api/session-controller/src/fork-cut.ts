/** Fork cuts over a complete Session log and the queued input a cut carries into a child. */

import type {} from '@deepseek-ai/dsh-agent/types'
import type { SessionEvent, SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'

/**
 * Whether an event admits input that a completed-turn prefix must exclude.
 * @param event - candidate prefix event.
 * @returns true for a turn start, an appended user message, or an inbox splice.
 */
function admitsInput(event: SessionEvent): boolean {
  return event.type === 'turn/start'
    || (event.type === 'user/message' && event.surfaceOp === 'append')
    || event.type === 'agent/inbox/spliced'
}

/**
 * Extend a prefix through standalone events up to the first event that admits input.
 * @param events - complete log with contiguous seqs from zero.
 * @param after - last event already in the prefix; undefined starts at seq 0.
 * @param limit - exclusive seq the extension never reaches.
 * @returns the extended inclusive boundary, or `after` when no event qualifies.
 */
function extendThroughStandalone(
  events: readonly SessionEvent[],
  after: SessionSeq | undefined,
  limit: number,
): SessionSeq | undefined {
  let boundary = after
  for (const next of events.slice(after === undefined ? 0 : after + 1, limit)) {
    if (admitsInput(next)) break
    boundary = next.seq
  }
  return boundary
}

/**
 * Latest completed-turn prefix: the last `turn/end` plus the standalone events
 * after it, stopping before the next turn or queued input. `session.fork`
 * uses this cut when `atSeq` is omitted; a caller that forks later passes the
 * value it computed as `atSeq` to keep the cut fixed while the source grows.
 * @param events - complete log with contiguous seqs from zero.
 * @returns the inclusive fork boundary for `session.fork`'s `atSeq`, or
 *   undefined when the log has no `turn/end`.
 */
export function latestCompletedPrefixBoundary(events: readonly SessionEvent[]): SessionSeq | undefined {
  const lastTurnEnd = events.findLast(event => event.type === 'turn/end')
  if (lastTurnEnd === undefined) return undefined
  return extendThroughStandalone(events, lastTurnEnd.seq, events.length)
}

/**
 * Fork cut that keeps every turn before `turn` and excludes the input that
 * opened it: the last `turn/end` before that `turn/start`, extended through
 * standalone events such as `model/selection` and stopping before an appended
 * `user/message` or an `agent/inbox/spliced` insertion. Before the first
 * completed turn the cut is the last standalone event that precedes the first
 * input. A prompt queued while the previous turn ran is spliced inside that
 * turn, so the cut still carries it; {@link inheritedNextTurnPrompts} lists
 * what the child must remove.
 * @param events - complete log with contiguous seqs from zero.
 * @param turn - turn whose opening prompt the child replaces.
 * @returns the inclusive boundary for `session.fork`'s `atSeq`, or undefined
 *   when the log has no `turn/start` for `turn`, or no completed turn precedes
 *   it and the log's first event admits input.
 */
export function completedPrefixBefore(events: readonly SessionEvent[], turn: number): SessionSeq | undefined {
  const start = events.find(event => event.type === 'turn/start' && event.data.turn === turn)
  if (start === undefined) return undefined
  const lastTurnEnd = events.findLast(event => event.seq < start.seq && event.type === 'turn/end')
  return extendThroughStandalone(events, lastTurnEnd?.seq, start.seq)
}

/**
 * Prompts still queued for later turns at a fork cut. The child's Inbox
 * replays every inherited `agent/inbox/spliced` event, so these prompts are
 * pending in the child and its next `followup` runs after them. A branch that
 * replaces a turn removes each one by id with `agent.inbox.remove`; next-step
 * input stays pending because the parent's following step claimed it.
 * @param events - complete log with contiguous seqs from zero.
 * @param boundary - inclusive fork boundary.
 * @returns the pending next-turn prompts in claim order.
 */
export function inheritedNextTurnPrompts(
  events: readonly SessionEvent[],
  boundary: SessionSeq,
): readonly UserMessage[] {
  let pending: readonly UserMessage[] = []
  for (const event of events.slice(0, boundary + 1)) {
    if (event.type !== 'agent/inbox/spliced' || event.data.target !== 'next-turn') continue
    pending = pending.toSpliced(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
  }
  return pending
}
