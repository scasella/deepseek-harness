/** The `loom` message source of autoloom child prompts and the run facts the autoloom tools report. */
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-typert-protocol'

/**
 * Source of the prompt a weaver model sent to one autoloom child through
 * `loom_expand`. A Session whose first own prompt carries it is an autoloom
 * child, and every autoloom tool refuses to run in it.
 */
export interface LoomMessageSource {
  readonly kind: 'loom'
  /** Weaver Session whose model sent the prompt. */
  readonly weaver: SessionId
  /** The weaver's `loom_expand` call that sent the prompt. */
  readonly callId: ToolCallId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Prompt a weaver model sent to one autoloom child through `loom_expand`.
     * @persistenceAttribution
     */
    loom: LoomMessageSource
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * The Loom service admitted a queued autoloom child after its weaver's
     * own-token budget ran out (`budget`) or after the autoloom tools unloaded
     * (`unloaded`); the child keeps its Session and gets no prompt.
     */
    'autoloom/child-refused': { readonly reason: 'budget' | 'unloaded' }
  }
}

/** Budget of one weaver Session after schema defaults. */
export interface AutoloomBudget {
  /** Most children the weaver may start. */
  readonly maxBranches: number
  /** Deepest generation of children below the first Session the weaver branched that is not its own child. */
  readonly maxDepth: number
  /** Most tokens the weaver's children may use in their own requests, summed over every child. */
  readonly maxOwnTokens: number
  /** Optional list-price dollar ceiling; a route without configured prices is refused. */
  readonly maxUsd?: number
  /** Permission preset every child runs with; its approval policy is `never`. */
  readonly childPermissionPreset: string
}

/** What remains of one weaver's budget, as every autoloom tool result reports it. */
export interface AutoloomBudgetLeft {
  /** Children the weaver may still start. */
  readonly branchesLeft: number
  /** Own tokens the weaver's children may still use before every running child is stopped. */
  readonly ownTokensLeft: number
  /** The configured maximum depth. */
  readonly maxDepth: number
  /** Remaining list-price dollars when a dollar ceiling is configured. */
  readonly usdLeft?: number
}
