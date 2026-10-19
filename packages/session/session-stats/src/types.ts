/**
 * Pure types of the session-stats domain: the ONE home of the `sessionStats`
 * projection-key declaration, free of this package's host-side value imports
 * (cordis context, zod, the llm chunk predicate). Two namespace projections
 * serve it — `./types` for host consumers, `./client` for client aggregates —
 * with zero content duplication.
 *
 * @module @deepseek-ai/dsh-session-stats/types
 */

// Marks this file a module so the declaration below AUGMENTS the projection
// table instead of declaring an ambient module.
export {}

/**
 * Conversation counts and wall times folded from durable session events;
 * every field is 0 until its first contributing event lands. Field names
 * mirror the client window fold so an assembly without this unit can fall
 * back to it wholesale.
 */
export interface SessionStatsFigures {
  /** Distinct turns carrying at least one closed step (`step/end`); rejected or empty turns are uncounted. */
  turns: number
  /** Closed steps (`step/end` events) — completed, failed, and cancelled steps alike. */
  steps: number
  /** Summed model wall time (`step/start` → `assistant/message`) over steps that assembled a message. */
  llmMs: number
  /** Summed tool wall time over `tool/call` → `tool/result` pairs matched by callId. */
  toolMs: number
  /** Summed first-token latency (`step/start` → first non-empty delta chunk) over `ttftSteps`. */
  ttftMs: number
  /** Steps carrying a recorded first token. */
  ttftSteps: number
  /** Summed decode wall time (first token → `assistant/message`) over steps that also report output tokens. */
  decodeMs: number
  /** Summed provider output tokens over the same decode-timed steps. */
  decodeTokens: number
}

/**
 * A fork's figures split at its cut. Per field, `own + inherited` equals the
 * whole-log figure that carries the split.
 */
export interface SessionStatsForkSplit {
  /** Figures of the turns this Session ran itself. */
  own: SessionStatsFigures
  /**
   * Figures of the turns opened in the fork-inherited prefix
   * (`seq < inheritedEventCount`), across every ancestor, including the seed's
   * synthetic closers of a turn the cut interrupted.
   */
  inherited: SessionStatsFigures
}

/**
 * Whole-log conversation figures, independent of how much history a client
 * has paged in. The top-level figures fold the complete durable log,
 * including a fork-inherited prefix. `fork` is present exactly when the
 * Session has a nonempty fork-inherited prefix (`inheritedEventCount > 0`);
 * otherwise the key is absent.
 */
export interface SessionStatsProjection extends SessionStatsFigures {
  /** Own and inherited figures of a Session with a fork-inherited prefix. */
  fork?: SessionStatsForkSplit
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Whole-log turn/step counts and wall times, split at a fork cut; see {@link SessionStatsProjection}. */
    sessionStats: SessionStatsProjection
  }
}
