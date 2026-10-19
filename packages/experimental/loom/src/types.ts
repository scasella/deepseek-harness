/** JSON-safe Loom identities, plugin records, projection values, and `loom` Remote inputs and results. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-projection/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** One node of a Loom tree; a Session node uses the Session id as its text. */
export type LoomNodeId = Branded<'LoomNodeId'>

/** One branch request that created sibling children at a single cut. */
export type LoomSetId = Branded<'LoomSetId'>

/** One autoloom run that created branch sets under its budgets. */
export type LoomRunId = Branded<'LoomRunId'>

/** How a branch request derived the children of one set. */
export type LoomBranchKind = 'regenerate' | 'steer' | 'edit' | 'variant' | 'autoloom'

/**
 * Branch-set membership that the branch runner writes into a child after its
 * fork and before its first prompt. A child owns its membership; the source
 * Session is never written.
 */
export interface LoomBranchRecord {
  /** Record payload version; readers ignore other versions. */
  readonly version: 1
  /** Branch request that created this child. */
  readonly setId: LoomSetId
  /** Session the child was forked from. */
  readonly sourceSessionId: SessionId
  /** Last source event the child inherited. */
  readonly atSeq: SessionSeq
  /** One-based position of this child within its set. */
  readonly variant: number
  /** Number of children the set requested. */
  readonly variantCount: number
  /** How the set derived its children. */
  readonly kind: LoomBranchKind
  /** Digest of the prompt variant that produced this child, for prompt-variant sets. */
  readonly variantKey?: string
  /** Autoloom run that requested the set. */
  readonly runId?: LoomRunId
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Branch-set membership of the Session that holds it, written before its first prompt and never model-visible. */
    'plugin:loom/branch': LoomBranchRecord
  }
}

/**
 * Loom membership of one Session. Only a branch record at or after
 * `inheritedEventCount` belongs to this Session, because a fork of a branch
 * inherits the branch record of its source. The `forkLineage` projection
 * names the same cut as `cutSeq`, the seq of the last inherited event.
 */
export interface LoomBranchView {
  /** Exact count of events the Session inherited from its fork source; equal to the first seq this Session wrote itself. */
  readonly inheritedEventCount: number
  /** First valid own branch record, or null when this Session is not a Loom branch. */
  readonly branch: LoomBranchRecord | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Inherited event count and own Loom branch membership. */
    loomBranch: LoomBranchView
  }
  interface SessionProjectionMap {
    /** Inherited event count and own Loom branch membership. */
    loomBranch: LoomBranchView
  }
}

/** Fork-family read for one Session. */
export interface LoomFamilyRequest {
  /** Any member of the family. */
  readonly sessionId: SessionId
}

/** One Session in a fork family, with the list facts current when the family was derived. */
export interface LoomFamilyNode {
  /** Tree node of this Session. */
  readonly id: LoomNodeId
  /** Session this node represents. */
  readonly sessionId: SessionId
  /** Fork source node, absent for the family root. */
  readonly parentId?: LoomNodeId
  /** Number of fork steps from the family root. */
  readonly depth: number
  /** Header creation time in Unix epoch milliseconds, absent when the list row carries no `forkLineage` hint. */
  readonly createdAt?: number
  /** Last Session activity in Unix epoch milliseconds. */
  readonly updatedAt: number
  /** Whether the Session's Agent was running. */
  readonly running: boolean
  /** Whether the Session had no turn yet. */
  readonly blank: boolean
}

/**
 * Fork family of one Session: its highest listed fork ancestor and every
 * listed fork descendant of that ancestor. Subagent children are not fork
 * members. Nodes are in depth-first order, siblings ordered by creation time
 * and then by Session id; a sibling without a creation time follows every
 * sibling with one.
 */
export interface LoomFamily {
  /** Family root node. */
  readonly rootId: LoomNodeId
  /** Node of the requested Session. */
  readonly focusId: LoomNodeId
  /** Every family node, root first. */
  readonly nodes: readonly LoomFamilyNode[]
}
