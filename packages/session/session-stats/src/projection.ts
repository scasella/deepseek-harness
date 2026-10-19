/**
 * The `sessionStats` projection unit: a pure fold of step boundaries, stream
 * embedded streams, tool pairs, and assembled assistant messages into whole-log counts
 * and wall times.
 *
 * `step/end` — not `assistant/message` — is the counted step event because it
 * is the step lifecycle authority: the loop appends exactly one per entered
 * step, in a `finally`, so completed, failed, cancelled, and max-tokens steps
 * all land one. Counting assembled assistant messages instead would overcount
 * max-tokens usage-host messages (empty content, excluded from the surface)
 * and undercount cancelled steps (aborted before the message assembles).
 *
 * The wall-time folds mirror the client window fold field by field
 * (`deriveStats` in dsh-client-ui-conversation, that fold's whole-window
 * fallback role): model time is `step/start` → `assistant/message`, first
 * token is the first non-empty delta chunk and survives an in-step
 * `llm/retry`, decode spans first token → assembled message on steps that
 * also report output tokens, and tool time pairs `tool/call` → `tool/result`
 * by callId. A cancelled step assembles no message, so its partial stream
 * time stays uncounted in every time figure — matching the window, which
 * renders it as an untimed interrupted node.
 *
 * A fork folds its own and inherited turns separately. An event is inherited
 * when it precedes the cut (`seq < inheritedEventCount`) or belongs to a turn
 * opened before the cut: the seed's synthetic `tool/result`, `step/end`, and
 * `turn/end` closers of an interrupted turn follow the cut but close an
 * inherited turn. Turn numbers are monotonic per Session and the fork's first
 * own turn numbers past every inherited one, so the two folds never share a
 * turn, a step, or a tool call.
 *
 * @module @deepseek-ai/dsh-session-stats/projection
 */

import { z } from 'zod'
import { assistantStreamFirstTokenTime } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionStatsFigures, SessionStatsProjection } from './types.ts'

/**
 * One side's fold: the figures plus the in-flight boundaries they accrue
 * from. Turn numbers are host-assigned and monotonic per session, so a single
 * `lastTurn` slot decides "first closed step of a new turn"; the state is
 * plain JSON per the unit contract (persisted-cache precondition).
 */
interface SessionStatsFold extends SessionStatsFigures {
  /** Turn of the last counted `step/end`; null before the first. */
  lastTurn: number | null
  /** The open step's boundary facts; null outside a step or after its message assembled. */
  openStep: { turn: number; step: number; startTime: number; firstTokenTime: number | null } | null
  /** Dispatch times of tool calls whose result has not landed, by callId. */
  pendingCalls: Record<string, number>
}

/** Fold state: the own and inherited folds and the facts that route events between them. */
interface SessionStatsState {
  /** Exact fork-inherited prefix length; 0 for a Session that is not a fork. */
  inheritedEventCount: SessionLogOffsetType
  /** Highest turn number read before the cut; null when the prefix carries none. */
  inheritedTurn: number | null
  /** Turns this Session ran itself; every turn of a Session that is not a fork. */
  own: SessionStatsFold
  /** Turns opened before the cut; stays at zero for a Session that is not a fork. */
  inherited: SessionStatsFold
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    sessionStats: SessionStatsState
  }
}

const sessionStatsSchema = z.object({
  turns: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  llmMs: z.number().nonnegative(),
  toolMs: z.number().nonnegative(),
  ttftMs: z.number().nonnegative(),
  ttftSteps: z.number().int().nonnegative(),
  decodeMs: z.number().nonnegative(),
  decodeTokens: z.number().nonnegative(),
}).strict()

const sessionStatsViewSchema: z.ZodType<SessionStatsProjection> = sessionStatsSchema.extend({
  fork: z.object({ own: sessionStatsSchema, inherited: sessionStatsSchema }).strict().optional(),
}).strict().transform(({ fork, ...total }) => ({ ...total, ...fork === undefined ? {} : { fork } }))

/**
 * One side's fold fields (figures plus in-flight boundaries). Each side's
 * figures are a strict subset of its fold, so this schema extends
 * `sessionStatsSchema` (the wire output boundary) with the boundary fields.
 */
const sessionStatsFoldSchema = sessionStatsSchema.extend({
  lastTurn: z.number().int().nonnegative().nullable(),
  openStep: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    startTime: z.number().nonnegative(),
    firstTokenTime: z.number().nonnegative().nullable(),
  }).nullable(),
  pendingCalls: z.record(z.string(), z.number().nonnegative()),
})

/**
 * The fold state, validated on persisted-cache rows after their `ver` gate —
 * the unit's input boundary.
 */
const sessionStatsStateSchema = z.object({
  inheritedEventCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionLogOffset),
  inheritedTurn: z.number().int().nonnegative().nullable(),
  own: sessionStatsFoldSchema,
  inherited: sessionStatsFoldSchema,
}).strict()

/**
 * Provider-reported completion tokens, guarded the way the window fold guards
 * node usage.
 * @param usage - the assistant/message event's optional usage record.
 * @returns the output-token count, or null when unreported or invalid.
 */
function usageOutputTokens(usage: unknown): number | null {
  if (typeof usage !== 'object' || usage === null) return null
  const value = (usage as { outputTokens?: unknown }).outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

const emptyFold = (): SessionStatsFold => ({
  turns: 0,
  steps: 0,
  llmMs: 0,
  toolMs: 0,
  ttftMs: 0,
  ttftSteps: 0,
  decodeMs: 0,
  decodeTokens: 0,
  lastTurn: null,
  openStep: null,
  pendingCalls: {},
})

/**
 * Fold one event into one side. Every uninteresting event returns the same
 * reference (Object.is gates the change feed).
 * @param state - the side's fold covering all prior events routed to it.
 * @param event - the next committed event routed to this side.
 * @returns the side's next fold.
 */
function applyFold(state: SessionStatsFold, event: SessionEvent): SessionStatsFold {
  switch (event.type) {
    case 'step/start':
      return {
        ...state,
        openStep: { turn: event.data.turn, step: event.data.step, startTime: event.time, firstTokenTime: null },
      }
    case 'assistant/attempt': {
      const open = state.openStep
      if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) return state
      const first = assistantStreamFirstTokenTime(event.data.stream) ?? null
      if (open.firstTokenTime !== null || first === null) return state
      return { ...state, openStep: { ...open, firstTokenTime: first } }
    }
    case 'assistant/message': {
      const open = state.openStep
      if (open === null || open.turn !== event.data.turn || open.step !== event.data.step) return state
      const firstToken = open.firstTokenTime ?? assistantStreamFirstTokenTime(event.data.stream) ?? null
      // One assembled message per step: closing the boundary means a
      // defensive duplicate cannot accrue twice.
      const next: SessionStatsFold = {
        ...state,
        llmMs: state.llmMs + Math.max(0, event.time - open.startTime),
        openStep: null,
      }
      if (firstToken !== null) {
        next.ttftMs += Math.max(0, firstToken - open.startTime)
        next.ttftSteps += 1
        const outputTokens = usageOutputTokens(event.data.usage)
        if (outputTokens !== null) {
          next.decodeMs += Math.max(0, event.time - firstToken)
          next.decodeTokens += outputTokens
        }
      }
      return next
    }
    case 'tool/call':
      return { ...state, pendingCalls: { ...state.pendingCalls, [event.data.callId]: event.time } }
    case 'tool/result': {
      // Own-key check: callId is provider-minted (model/tool JSON boundary),
      // so a prototype property name ('constructor', 'toString') on a result
      // with no recorded call must read as unmatched, not as an inherited
      // function that would poison toolMs with NaN.
      const callId = event.data.message.source.callId
      const dispatched = Object.hasOwn(state.pendingCalls, callId) ? state.pendingCalls[callId] : undefined
      if (dispatched === undefined) return state
      const pendingCalls = Object.fromEntries(
        Object.entries(state.pendingCalls).filter(([id]) => id !== callId),
      )
      return { ...state, toolMs: state.toolMs + Math.max(0, event.time - dispatched), pendingCalls }
    }
    case 'step/end':
      return {
        ...state,
        turns: state.lastTurn === event.data.turn ? state.turns : state.turns + 1,
        steps: state.steps + 1,
        lastTurn: event.data.turn,
        openStep: null,
      }
    case 'turn/end':
      // A call whose result never landed belongs to a cancelled or failed
      // turn; results always land within their turn, so drop the leftovers
      // instead of growing persisted state forever.
      return Object.keys(state.pendingCalls).length === 0 ? state : { ...state, pendingCalls: {} }
    default:
      return state
  }
}

/**
 * The turn number of an event the fold reads.
 * @param event - one committed event.
 * @returns the event's turn, or undefined for an event no side folds.
 */
function turnOf(event: SessionEvent): number | undefined {
  switch (event.type) {
    case 'turn/start':
    case 'turn/end':
    case 'step/start':
    case 'step/end':
    case 'assistant/attempt':
    case 'assistant/message':
    case 'tool/call':
    case 'tool/result':
      return event.data.turn
    default:
      return undefined
  }
}

/**
 * One side's figures without its in-flight boundaries.
 * @param fold - one side's fold.
 * @returns the side's eight figures.
 */
function figuresOf(fold: SessionStatsFold): SessionStatsFigures {
  return {
    turns: fold.turns,
    steps: fold.steps,
    llmMs: fold.llmMs,
    toolMs: fold.toolMs,
    ttftMs: fold.ttftMs,
    ttftSteps: fold.ttftSteps,
    decodeMs: fold.decodeMs,
    decodeTokens: fold.decodeTokens,
  }
}

/** The `sessionStats` unit registered on `ctx.sessionProjections` (exported for the unit spec). */
export const sessionStatsProjectionDefinition = {
  key: 'sessionStats',
  stateVersion: 2,
  stateSchema: sessionStatsStateSchema,
  init: (_header, inheritedEventCount) => ({
    inheritedEventCount,
    inheritedTurn: null,
    own: emptyFold(),
    inherited: emptyFold(),
  }),
  apply: (state, event) => {
    const turn = turnOf(event)
    if (turn === undefined) return state
    if (event.seq < state.inheritedEventCount) {
      const inherited = applyFold(state.inherited, event)
      const inheritedTurn = state.inheritedTurn === null || turn > state.inheritedTurn ? turn : state.inheritedTurn
      return inherited === state.inherited && inheritedTurn === state.inheritedTurn
        ? state
        : { ...state, inheritedTurn, inherited }
    }
    if (state.inheritedTurn !== null && turn <= state.inheritedTurn) {
      const inherited = applyFold(state.inherited, event)
      return inherited === state.inherited ? state : { ...state, inherited }
    }
    const own = applyFold(state.own, event)
    return own === state.own ? state : { ...state, own }
  },
  wire: {
    viewSchema: sessionStatsViewSchema,
    view: (state) => {
      const own = figuresOf(state.own)
      if (state.inheritedEventCount === 0) return own
      const inherited = figuresOf(state.inherited)
      return {
        turns: own.turns + inherited.turns,
        steps: own.steps + inherited.steps,
        llmMs: own.llmMs + inherited.llmMs,
        toolMs: own.toolMs + inherited.toolMs,
        ttftMs: own.ttftMs + inherited.ttftMs,
        ttftSteps: own.ttftSteps + inherited.ttftSteps,
        decodeMs: own.decodeMs + inherited.decodeMs,
        decodeTokens: own.decodeTokens + inherited.decodeTokens,
        fork: { own, inherited },
      }
    },
  },
} satisfies ProjectionDefinition<'sessionStats', SessionStatsState>
