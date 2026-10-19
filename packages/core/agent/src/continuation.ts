/** Failures admitting a turn over existing model history. */

/** Why an Agent cannot continue its existing history. */
export type AgentContinuationFailure = 'busy' | 'pending-input' | 'pending-tools' | 'empty-history' | 'assistant-tail'

/** A refused continuation; no turn or inbox mutation has committed. */
export class AgentContinuationError extends Error {
  /** @param reason - stable condition the caller must resolve before retrying. */
  constructor(readonly reason: AgentContinuationFailure) {
    super(`Cannot continue this agent: ${reason}`)
    this.name = 'AgentContinuationError'
  }
}
