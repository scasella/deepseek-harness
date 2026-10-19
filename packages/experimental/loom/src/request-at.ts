/** Rebuild what the model received in one request from a complete Session log. */
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import {
  deriveEventMessage,
  foldRequestHeader,
  foldSurface,
  SessionSeq,
  type EpochHeader,
  type SessionEvent,
  type SessionId,
  type SessionMessageProjection,
} from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { isSettlement } from './route.ts'
import type { LoomRequestMessage, LoomRequestSystemPrompt, LoomRequestTools, LoomRequestView } from './types.ts'

/** Most Unicode code points a request message preview holds, its trailing `…` included. */
export const LOOM_REQUEST_PREVIEW_MAX_CODE_POINTS = 240

/** One message of a rebuilt request and the surface event that produced it. */
export interface RebuiltRequestNode {
  /** Surface event that produced the message. */
  readonly seq: SessionSeq
  /** Message as the request carried it, with logged message projections applied. */
  readonly message: Message
}

/** The request settled at one event, rebuilt from the log prefix before that event. */
export interface RebuiltRequest {
  /** The request's `assistant/message` or `assistant/attempt`. */
  readonly settlement: SessionEvent<'assistant/message'> | SessionEvent<'assistant/attempt'>
  /** Header in force when the request was sent; undefined when the prefix logs none. */
  readonly header: EpochHeader | undefined
  /** Request messages in model-visible order. */
  readonly nodes: readonly RebuiltRequestNode[]
}

/** A complete Session log and its fork cut, as `SessionController.inspect` returns them. */
export interface RequestLog {
  /** Every event from seq 0, contiguous. */
  readonly events: readonly SessionEvent[]
  /** Number of leading events the Session inherited from its fork source. */
  readonly inheritedEventCount: number
}

/**
 * Find the latest request settlement at or before a seq.
 * @param events - complete log.
 * @param seq - seq of an existing event.
 * @returns the settlement, or undefined when no request settled by then.
 */
function settlementAt(
  events: readonly SessionEvent[],
  seq: number,
): SessionEvent<'assistant/message'> | SessionEvent<'assistant/attempt'> | undefined {
  return events.slice(0, seq + 1).findLast(isSettlement)
}

/**
 * Rebuild the request whose settlement is `settlement`: the loop derives a
 * request's messages from the surface it held right before the settlement,
 * and the header from the latest `request/header` before it.
 * @param events - complete log.
 * @param settlement - an `assistant/message` or `assistant/attempt` of `events`.
 * @param projections - message projections that interpret plugin-owned events of the log.
 * @returns the header and messages of that request.
 * @throws when an interpreter is missing or the log violates a surface rule.
 */
export function rebuildRequest(
  events: readonly SessionEvent[],
  settlement: SessionEvent<'assistant/message'> | SessionEvent<'assistant/attempt'>,
  projections: readonly SessionMessageProjection[],
): RebuiltRequest {
  const prefix = events.slice(0, settlement.seq)
  const surface = foldSurface(prefix, projections)
  const nodes = surface.nodes.flatMap((seq) => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- surface nodes index the folded prefix by construction
    const message = deriveEventMessage(prefix[seq]!, surface.projectedMessages)
    return message === null ? [] : [{ seq, message }]
  })
  return { settlement, header: foldRequestHeader(prefix), nodes }
}

/**
 * Render one content block as message text.
 * @param block - model-facing block.
 * @returns the block's text, or an empty string for a block type this package does not render.
 */
function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return block.text
    case 'tool-call':
      return `${block.name} ${block.arguments}`
    case 'tool-addition':
      return `+${block.toolName}`
    case 'tool-removal':
      return `-${block.toolName}`
    case 'image':
      return `[${block.attachment.name ?? block.attachment.mediaType}]`
    case 'file':
      return `[${block.attachment.name}]`
    default:
      // Merge-extensible union: a plugin-declared block contributes no text.
      return ''
  }
}

/**
 * Render a message as text, one nonempty block per line.
 * @param message - request message or request-only user input.
 * @returns the message text.
 */
export function messageText(message: Pick<Message, 'content'>): string {
  return message.content.map(blockText).filter(text => text.length > 0).join('\n')
}

/**
 * Cut collapsed text to the preview bound.
 * @param text - complete message text.
 * @returns the preview defined by {@link LoomRequestMessage.preview}.
 */
export function previewOf(text: string): string {
  const points = Array.from(text.replace(/\s+/gu, ' ').trim())
  return points.length <= LOOM_REQUEST_PREVIEW_MAX_CODE_POINTS
    ? points.join('')
    : `${points.slice(0, LOOM_REQUEST_PREVIEW_MAX_CODE_POINTS - 1).join('')}…`
}

/**
 * Summarize one request message for the view.
 * @param node - rebuilt message and its producing event.
 * @param inheritedEventCount - the Session's fork cut.
 * @returns the message row.
 */
export function messageRow(node: RebuiltRequestNode, inheritedEventCount: number): LoomRequestMessage {
  const text = messageText(node.message)
  const { role } = node.message
  return {
    seq: node.seq,
    role: role === 'developer' ? 'system' : role,
    inherited: node.seq < inheritedEventCount,
    preview: previewOf(text),
    chars: Array.from(text).length,
  }
}

/**
 * Read the effective system prompt of a rebuilt request.
 * @param events - complete log.
 * @param nodes - rebuilt request messages.
 * @returns the last nonempty system node's text and the turn that wrote it.
 */
function systemPromptOf(events: readonly SessionEvent[], nodes: readonly RebuiltRequestNode[]): LoomRequestSystemPrompt {
  for (const node of nodes.toReversed()) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- surface nodes index the log by construction
    const event = events[node.seq]!
    if (event.type !== 'system/message') continue
    const text = messageText(node.message)
    const first = events.find(candidate => candidate.type === 'system/message')
    return { chars: Array.from(text).length, text, ...event === first ? {} : { changedAtTurn: event.data.turn } }
  }
  return { chars: 0, text: '' }
}

/**
 * Collect the tool changes logged in the request's turn before it. Turn
 * numbers are unique within one log, inherited turns included, so the turn
 * number alone selects the turn's events.
 * @param events - complete log.
 * @param settlement - the request's settlement.
 * @param header - header in force.
 * @returns request tool names and this turn's additions and removals.
 */
function toolsOf(
  events: readonly SessionEvent[],
  settlement: RebuiltRequest['settlement'],
  header: EpochHeader,
): LoomRequestTools {
  const added = new Set<string>()
  const removed = new Set<string>()
  for (const event of events.slice(0, settlement.seq)) {
    if (event.type !== 'developer/message' || event.data.turn !== settlement.data.turn) continue
    for (const block of event.data.message.content) {
      if (block.type === 'tool-addition') added.add(block.toolName)
      else if (block.type === 'tool-removal') removed.add(block.toolName)
    }
  }
  return { names: (header.tools ?? []).map(tool => tool.name), addedThisTurn: [...added], removedThisTurn: [...removed] }
}

/**
 * Build the view of the request in force at one event of a Session.
 * @param sessionId - Session the log belongs to, for failure details.
 * @param log - complete log and fork cut.
 * @param seq - event the caller addressed.
 * @param projections - message projections that interpret plugin-owned events of the log.
 * @returns the view of the latest request settled at or before `seq`.
 * @throws RemoteError `loom/seq-out-of-range` when `seq` is not a seq of the log or precedes the first settlement.
 * @throws RemoteError `gateway/internal` when the log holds no `request/header` before the request.
 */
export function requestViewAt(
  sessionId: SessionId,
  log: RequestLog,
  seq: number,
  projections: readonly SessionMessageProjection[],
): LoomRequestView {
  const { events, inheritedEventCount } = log
  const settlement = Number.isSafeInteger(seq) && seq >= 0 && seq < events.length ? settlementAt(events, seq) : undefined
  if (settlement === undefined) {
    const first = events.find(isSettlement)
    throw new RemoteError('loom/seq-out-of-range', `Session "${sessionId}" has no model request at or before seq ${String(seq)}`, {
      sessionId,
      seq,
      range: first === undefined ? null : { from: first.seq, to: SessionSeq(events.length - 1) },
    })
  }
  const { header, nodes } = rebuildRequest(events, settlement, projections)
  if (header === undefined) {
    throw new RemoteError('gateway/internal', `Session "${sessionId}" logs no request/header before the request settled at seq ${String(settlement.seq)}`, {})
  }
  const { config } = header
  let inheritedTurns = 0
  let ownTurns = 0
  for (const event of events.slice(0, settlement.seq)) {
    if (event.type !== 'turn/start') continue
    if (event.seq < inheritedEventCount) inheritedTurns += 1
    else ownTurns += 1
  }
  return {
    route: {
      provider: config.provider,
      model: config.model,
      ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    },
    systemPrompt: systemPromptOf(events, nodes),
    tools: toolsOf(events, settlement, header),
    messages: nodes.map(node => messageRow(node, inheritedEventCount)),
    inheritedTurns,
    ownTurns,
  }
}
