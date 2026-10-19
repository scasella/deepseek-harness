/**
 * Explicit resolution of one `loom.branch` request against the source's log:
 * the fork cut, every child's prompt, and the admission facts, computed and
 * validated before any fork.
 */
import { createHash } from 'node:crypto'
import {
  completedPrefixBefore,
  inheritedNextTurnPrompts,
  latestCompletedPrefixBoundary,
  type ModelSelection,
} from '@deepseek-ai/dsh-api-session-controller'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent, type SessionHeader, type SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { nextRouteAt, routeOfHeader, sameRoute } from './route.ts'
import type { LoomBranchKind, LoomBranchRequest, LoomEstimateRequest, LoomIsolation } from './types.ts'

/** One child the runner forks and prompts. */
export interface LoomChildSpec {
  /** Request index. */
  readonly index: number
  /** Prompt content the child receives. */
  readonly content: readonly ContentBlock[]
  /** Digest of the child's prompt line, for `variants` children. */
  readonly variantKey?: string
}

/** Everything one branch request fixes before its first fork. */
export interface LoomBranchSpec {
  /**
   * Session every child is forked from: the addressed Session, or its fork
   * parent for a regenerate or edit of its first own turn.
   */
  readonly sourceSessionId: SessionId
  readonly kind: LoomBranchKind
  /** Inclusive fork boundary in the source log. */
  readonly cut: SessionSeq
  /**
   * Route override for every child: the request's, or, for a first-own-turn
   * regenerate or edit that names none, the route the fork sent its first
   * request on when that differs from the route in force at the cut, else the
   * last route the fork selected before that turn started.
   */
  readonly selection?: ModelSelection
  /** Every child in request order. */
  readonly children: readonly LoomChildSpec[]
  /** Next-turn prompts still queued at the cut; each child removes them before its own prompt. */
  readonly inheritedPrompts: readonly MessageId[]
  /** Browser time zone recorded on the source prompt the children's prompts stand in for. */
  readonly clientTimeZone?: string
  /** Sandbox mode at the cut: the last `sandbox/mode` event through it, else the deployment default; undefined without a sandbox policy. */
  readonly mode: string | undefined
  /** Whether the children's inherited sandbox mode can write their folder. */
  readonly writable: boolean
  /** Where the children keep their files: the request's choice, else the configured default. */
  readonly isolation: LoomIsolation
  /** Project folder the children share with the source: its header `cwd`, or the empty string without one. */
  readonly folder: string
}

/** Limits and defaults one resolution reads. */
export interface LoomBranchPolicy {
  /** Configured `maxBranchesPerRequest`. */
  readonly maxBranchesPerRequest: number
  /**
   * Deployment sandbox mode for a cut that logs no `sandbox/mode` event;
   * undefined when no sandbox policy is composed, which counts as writable.
   */
  readonly defaultSandboxMode: string | undefined
  /** Configured `defaultIsolation`, for a request that names no `isolation`. */
  readonly defaultIsolation: LoomIsolation
  /**
   * Whether a regenerate or edit of a fork's first own turn is cut in the
   * fork's parent, beside the fork. False cuts it in the addressed fork, below
   * it, for a parent that no longer exists.
   */
  readonly redirect: boolean
}

/** Header, fork-inherited prefix length, and complete log of the addressed Session. */
export interface LoomBranchSource {
  readonly meta: SessionHeader
  /** Number of leading events the Session inherited from its fork parent; 0 for a Session that is not a fork. */
  readonly inheritedEventCount: number
  readonly events: readonly SessionEvent[]
}

/**
 * Digest of one prompt line: the first 16 hex digits of its SHA-256, so that
 * samples of one line share a key without the record repeating the text.
 * @param line - prompt line as sent.
 * @returns the variant key.
 */
export function variantKeyOf(line: string): string {
  return createHash('sha256').update(line).digest('hex').slice(0, 16)
}

/**
 * Failure of a branch or estimate request that names a turn it cannot use.
 * @param sessionId - source Session.
 * @param turn - the turn the request named.
 * @param reason - why the turn is unusable.
 * @returns the RemoteError.
 */
export function turnUnavailable(
  sessionId: SessionId,
  turn: number,
  reason: 'not-found' | 'not-ended' | 'not-user-opened' | 'no-cut',
): RemoteError<'loom/turn-unavailable'> {
  return new RemoteError('loom/turn-unavailable', `session "${sessionId}" cannot branch at turn ${String(turn)}: ${reason}`, { sessionId, turn, reason })
}

/**
 * Number of children a request creates, after checking its counts are
 * positive integers.
 * @param request - the branch request.
 * @returns the child count.
 * @throws RemoteError `gateway/bad-request` for a count, sample number, or line count that is not a positive integer.
 */
function childCount(request: LoomBranchRequest): number {
  const positive = (value: number, field: string): number => {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RemoteError('gateway/bad-request', `loom.branch ${field} must be a positive integer`, {})
    }
    return value
  }
  switch (request.kind) {
    case 'regenerate': return positive(request.count, 'count')
    case 'edit': return 1
    case 'steer': return positive(request.lines.length, 'line count')
    case 'variants': return positive(request.lines.length, 'line count') * positive(request.samples, 'samples')
    /* v8 ignore next 2 -- closed LoomBranchRequest union. */
    default:
      return assertNever(request)
  }
}

/**
 * The prompt that opened turn `turn`: the head of the next-turn queue when the
 * turn started, provided it entered the turn as a `user/message` from a user.
 * @param events - complete source log.
 * @param sessionId - source Session, for failures.
 * @param turn - turn to inspect.
 * @returns the opening prompt.
 * @throws RemoteError `loom/turn-unavailable` when the turn is absent or did not open with a user prompt.
 */
function openingPrompt(events: readonly SessionEvent[], sessionId: SessionId, turn: number): UserMessage {
  const start = events.find(event => event.type === 'turn/start' && event.data.turn === turn)
  if (start === undefined) throw turnUnavailable(sessionId, turn, 'not-found')
  const opening = inheritedNextTurnPrompts(events, start.seq)[0]
  const next = events.find(event => event.seq > start.seq && event.type === 'turn/start')?.seq ?? events.length
  const entered = opening !== undefined && events.some(event =>
    event.seq > start.seq && event.seq < next && event.type === 'user/message' && event.data.id === opening.id)
  if (!entered || opening.source.kind !== 'user') throw turnUnavailable(sessionId, turn, 'not-user-opened')
  return opening
}

/**
 * The cut at the end of turn `afterTurn`: its `turn/end` extended through the
 * standalone events after it, stopping before the next turn or queued input.
 * @param events - complete source log.
 * @param sessionId - source Session, for failures.
 * @param afterTurn - last turn the children keep.
 * @returns the inclusive fork boundary.
 * @throws RemoteError `loom/turn-unavailable` when the turn is absent, has not ended, or leaves no cut.
 */
export function cutAfter(events: readonly SessionEvent[], sessionId: SessionId, afterTurn: number): SessionSeq {
  const opens = (turn: number) => events.some(event => event.type === 'turn/start' && event.data.turn === turn)
  if (!events.some(event => event.type === 'turn/end' && event.data.turn === afterTurn)) {
    throw turnUnavailable(sessionId, afterTurn, opens(afterTurn) ? 'not-ended' : 'not-found')
  }
  const cut = opens(afterTurn + 1) ? completedPrefixBefore(events, afterTurn + 1) : latestCompletedPrefixBoundary(events)
  if (cut === undefined) throw turnUnavailable(sessionId, afterTurn, 'no-cut')
  return cut
}

/** Where a first-own-turn regenerate or edit of a fork branches from. */
interface ForkParentCut {
  readonly sessionId: SessionId
  readonly cut: SessionSeq
  /**
   * The fork's own route, when the plain fork of its parent at the cut would
   * not take it: the route of the first `request/header` the fork logged in
   * its first own turn if that differs from the route in force at the cut,
   * else the last `model/selection` the fork logged before that turn started
   * (the route its fork recorded, or a later pick).
   */
  readonly selection?: ModelSelection
}

/**
 * Fork parent that a regenerate or edit of `turn` branches from instead of
 * the addressed Session: present when the Session is a fork, not a subagent
 * child, and `turn` is the first turn it started itself, so that the children
 * share the Session's parent and cut and become further variants beside it.
 * @param source - header, inherited prefix length, and log of the addressed Session.
 * @param turn - turn the request names.
 * @returns the parent, the cut, and the fork's own route, or undefined to cut in the addressed Session.
 */
function forkParentAt(source: LoomBranchSource, turn: number): ForkParentCut | undefined {
  const { meta, inheritedEventCount, events } = source
  if (meta.parentSession === undefined || meta.origin === 'subagent' || inheritedEventCount === 0) return undefined
  const firstOwn = events.find((event): event is SessionEvent<'turn/start'> => event.seq >= inheritedEventCount && event.type === 'turn/start')
  if (firstOwn?.data.turn !== turn) return undefined
  const cut = SessionSeq(inheritedEventCount - 1)
  const selection = usedRoute(events, firstOwn.seq, cut) ?? events.findLast((event): event is SessionEvent<'model/selection'> =>
    event.seq >= inheritedEventCount && event.seq < firstOwn.seq && event.type === 'model/selection')?.data
  return { sessionId: meta.parentSession, cut, ...selection === undefined ? {} : { selection } }
}

/**
 * Route a fork's first own request was sent on, when that is not the route in
 * force at the fork cut, which a plain fork of the parent there would take.
 * The request's header records what ran, so it outranks the picks the fork logged.
 * @param events - the fork's complete log.
 * @param start - seq of the fork's first own `turn/start`.
 * @param cut - the fork cut in the parent.
 * @returns the route, or undefined when the first own turn logged no header or its header names the route in force at the cut.
 */
function usedRoute(events: readonly SessionEvent[], start: number, cut: number): ModelSelection | undefined {
  const next = events.find(event => event.seq > start && event.type === 'turn/start')?.seq ?? events.length
  const header = events.find((event): event is SessionEvent<'request/header'> =>
    event.seq > start && event.seq < next && event.type === 'request/header')
  if (header === undefined) return undefined
  const used = routeOfHeader(header.data.header)
  const inCut = nextRouteAt(events, cut)
  return inCut !== undefined && sameRoute(used, inCut) ? undefined : used
}

/**
 * Cut and route for a cost preview, using the same opening-prompt and turn rules as branching.
 * @param request - preview request.
 * @param source - addressed Session's complete log and fork metadata.
 * @param maxBranches - configured maximum number of children.
 * @returns inclusive cut and the route that would run, when the log names one.
 * @throws RemoteError `gateway/bad-request`, `loom/too-many-branches`, or `loom/turn-unavailable`.
 */
export function resolveEstimate(
  request: Exclude<LoomEstimateRequest, { readonly kind: 'weave' }>,
  source: LoomBranchSource,
  maxBranches: number,
): { readonly cut: SessionSeq; readonly turn: number; readonly selection?: ModelSelection } {
  if (!Number.isSafeInteger(request.count) || request.count < 1) {
    throw new RemoteError('gateway/bad-request', 'loom.estimate count must be a positive integer', {})
  }
  if (request.count > maxBranches) {
    throw new RemoteError('loom/too-many-branches', `loom.estimate asks for ${String(request.count)} children; at most ${String(maxBranches)} are allowed`, {
      requested: request.count, limit: maxBranches,
    })
  }
  const turn = request.kind === 'regenerate' || request.kind === 'edit' ? request.turn : request.afterTurn
  if (turn === undefined || !Number.isSafeInteger(turn) || turn < 1) {
    throw new RemoteError('gateway/bad-request', 'loom.estimate requires a positive integer turn or afterTurn for its kind', {})
  }
  let cut: SessionSeq
  let selected: ModelSelection | undefined
  switch (request.kind) {
    case 'regenerate':
    case 'edit': {
      openingPrompt(source.events, request.sessionId, turn)
      const parent = forkParentAt(source, turn)
      const found = parent?.cut ?? completedPrefixBefore(source.events, turn)
      if (found === undefined) throw turnUnavailable(request.sessionId, turn, 'no-cut')
      cut = found
      selected = parent?.selection
      break
    }
    case 'steer':
    case 'variants':
      cut = cutAfter(source.events, request.sessionId, turn)
      break
    /* v8 ignore next 2 -- closed LoomBranchKind union. */
    default:
      return assertNever(request.kind)
  }
  selected ??= nextRouteAt(source.events, cut)
  if (selected === undefined) {
    const first = source.events.find((event): event is SessionEvent<'request/header'> => event.type === 'request/header')
    if (first !== undefined) selected = routeOfHeader(first.data.header)
  }
  const selection = request.selection ?? selected
  return { cut, turn, ...selection === undefined ? {} : { selection } }
}

/**
 * Replace the text parts of a prompt with one text part at the position of
 * the first, keeping every other part and its stored reference in order.
 * @param content - original prompt content.
 * @param text - replacement text.
 * @returns the edited content.
 */
export function editedContent(content: readonly ContentBlock[], text: string): readonly ContentBlock[] {
  const first = content.findIndex(block => block.type === 'text')
  const kept: readonly ContentBlock[] = content.filter(block => block.type !== 'text')
  return kept.toSpliced(Math.max(first, 0), 0, { type: 'text', text })
}

/**
 * Browser time zone of a user prompt, when its source recorded one.
 * @param message - a user prompt.
 * @returns the zone, or undefined.
 */
function timeZoneOf(message: UserMessage): string | undefined {
  return message.source.kind === 'user' && 'rpcId' in message.source ? message.source.clientTimeZone : undefined
}

/**
 * Resolve one branch request into the spec the runner executes. Every
 * validation failure is raised here, before any fork. A regenerate or edit of
 * a fork's first own turn resolves to the fork's parent at the fork's cut and
 * sends the fork's own opening prompt; without a request `selection`, the
 * children take the fork's own route, the one its first request was sent on
 * (when that differs from the route in force at the cut) or else the one it
 * selected before that turn, so they run on the fork's route, not on the parent's. The runner checks that the parent
 * exists and that the caller may branch it, and resolves again with
 * `policy.redirect` false when it does not, which cuts in the addressed fork.
 * Every other request is cut in the addressed Session.
 * @param request - the branch request.
 * @param source - header, inherited prefix length, and complete log of the addressed Session.
 * @param policy - configured limit, the deployment sandbox and isolation defaults, and whether to redirect to the fork parent.
 * @returns the spec.
 * @throws RemoteError `gateway/bad-request`, `loom/too-many-branches`, `loom/empty-line`, or `loom/turn-unavailable`.
 */
export function resolveBranch(request: LoomBranchRequest, source: LoomBranchSource, policy: LoomBranchPolicy): LoomBranchSpec {
  const { events } = source
  const count = childCount(request)
  if (count > policy.maxBranchesPerRequest) {
    throw new RemoteError('loom/too-many-branches', `loom.branch asks for ${String(count)} children; at most ${String(policy.maxBranchesPerRequest)} are allowed`, {
      requested: count, limit: policy.maxBranchesPerRequest,
    })
  }
  const lines = request.kind === 'edit' ? [request.text] : request.kind === 'regenerate' ? [] : request.lines
  const empty = lines.findIndex(line => line.trim().length === 0)
  if (empty !== -1) throw new RemoteError('loom/empty-line', `loom.branch line ${String(empty)} has no text`, { index: empty })

  let sourceSessionId = request.sessionId
  let selection = request.selection
  let cut: SessionSeq
  let children: LoomChildSpec[]
  let timeZoneSource: UserMessage | undefined
  switch (request.kind) {
    case 'regenerate':
    case 'edit': {
      const opening = openingPrompt(events, request.sessionId, request.turn)
      const parent = policy.redirect ? forkParentAt(source, request.turn) : undefined
      if (parent === undefined) {
        const found = completedPrefixBefore(events, request.turn)
        if (found === undefined) throw turnUnavailable(request.sessionId, request.turn, 'no-cut')
        cut = found
      } else {
        sourceSessionId = parent.sessionId
        cut = parent.cut
        selection ??= parent.selection
      }
      timeZoneSource = opening
      const content = request.kind === 'edit' ? editedContent(opening.content, request.text) : opening.content
      children = Array.from({ length: count }, (_, index) => ({ index, content }))
      break
    }
    case 'steer':
      cut = cutAfter(events, request.sessionId, request.afterTurn)
      children = request.lines.map((text, index): LoomChildSpec => ({ index, content: [{ type: 'text', text }] }))
      break
    case 'variants': {
      cut = cutAfter(events, request.sessionId, request.afterTurn)
      const { samples } = request
      children = request.lines.flatMap((text, line) => Array.from({ length: samples }, (_, sample): LoomChildSpec => ({
        index: line * samples + sample, content: [{ type: 'text', text }], variantKey: variantKeyOf(text),
      })))
      break
    }
    /* v8 ignore next 2 -- closed LoomBranchRequest union. */
    default:
      return assertNever(request)
  }
  const prefix = events.slice(0, cut + 1)
  timeZoneSource ??= prefix.findLast((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && timeZoneOf(event.data) !== undefined)?.data
  const clientTimeZone = timeZoneSource === undefined ? undefined : timeZoneOf(timeZoneSource)
  const mode = prefix.findLast((event): event is SessionEvent<'sandbox/mode'> => event.type === 'sandbox/mode')?.data.mode
    ?? policy.defaultSandboxMode
  return {
    sourceSessionId,
    kind: request.kind,
    cut,
    ...selection === undefined ? {} : { selection },
    children,
    inheritedPrompts: inheritedNextTurnPrompts(events, cut).map(message => message.id),
    ...clientTimeZone === undefined ? {} : { clientTimeZone },
    mode,
    writable: mode !== 'read-only',
    isolation: request.isolation ?? policy.defaultIsolation,
    folder: source.meta.cwd ?? '',
  }
}
