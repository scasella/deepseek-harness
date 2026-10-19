/** JSON-safe Loom identities, plugin records, projection values, and `loom` Remote inputs and results. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-projection/types'
import type { RemoteErrorCode } from '@deepseek-ai/dsh-typert-protocol'

/** One node of a Loom tree; a Session node uses the Session id as its text. */
export type LoomNodeId = Branded<'LoomNodeId'>

/** One branch request that created sibling children at a single cut. */
export type LoomSetId = Branded<'LoomSetId'>

/** Client-minted identity of one `loom.branch` call; a retry with the same identity for the same Session returns the first result. */
export type LoomBranchRequestId = Branded<'LoomBranchRequestId'>

/** How a branch request derived the children of one set. */
export type LoomBranchKind = 'regenerate' | 'steer' | 'edit' | 'variants'

/** Private curation mark of one Session. */
export type LoomMark = 'keep' | 'set-aside'

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
  /** How the set derived its children. */
  readonly kind: LoomBranchKind
  /** Zero-based position of this child in the request's child order. */
  readonly index: number
  /** Digest of the prompt line that produced this child; present exactly for `variants` sets. */
  readonly variantKey?: string
}

/**
 * Private curation mark written into the marked Session. The last own record
 * is the Session's mark; `mark: null` clears it.
 */
export interface LoomMarkRecord {
  /** Record payload version; readers ignore other versions. */
  readonly version: 1
  /** The new mark, or null to clear it. */
  readonly mark: LoomMark | null
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Branch-set membership of the Session that holds it, written before its first prompt and never model-visible. */
    'plugin:loom/branch': LoomBranchRecord
    /** Private keep or set-aside mark of the Session that holds it; never model-visible and never a feedback event. */
    'plugin:loom/mark': LoomMarkRecord
  }
}

/**
 * Loom branch membership of one Session: the first valid `plugin:loom/branch`
 * record at or after the Session's fork cut. A fork of a branch inherits its
 * source's record, which is not membership.
 */
export interface LoomBranchView {
  /** Branch request that created this Session. */
  readonly setId: LoomSetId
  /** How the set derived its children. */
  readonly kind: LoomBranchKind
  /** Zero-based position in the request's child order; equal to the child's `index` in `loom.branch` and `loom.setStatus`. */
  readonly index: number
  /** Digest of the prompt line that produced this child, present for `variants` sets; children with equal keys are samples of one line. */
  readonly variantKey?: string
  /** Time of the branch record in Unix epoch milliseconds. */
  readonly createdAt: number
}

/** Host fold state of the `loomBranch` unit. */
export interface LoomBranchState {
  /** Exact count of events the Session inherited from its fork source. */
  readonly inheritedEventCount: number
  /** Own branch membership, or null when the Session is not a Loom branch child. */
  readonly branch: LoomBranchView | null
}

/** Current private mark of one Session, from its last own `plugin:loom/mark` record. */
export interface LoomMarkView {
  readonly mark: LoomMark
}

/** Host fold state of the `loomMark` unit. */
export interface LoomMarkState {
  /** Exact count of events the Session inherited from its fork source. */
  readonly inheritedEventCount: number
  /** Own current mark, or null when the Session has none. */
  readonly mark: LoomMarkView | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Inherited event count and own Loom branch membership. */
    loomBranch: LoomBranchState
    /** Inherited event count and own private mark. */
    loomMark: LoomMarkState
  }
  interface SessionProjectionMap {
    /** Own Loom branch membership; null for a Session that is not a Loom branch child. */
    loomBranch: LoomBranchView | null
    /** Own private mark; null for a Session without one. */
    loomMark: LoomMarkView | null
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * `loom.requestAt` named a seq outside the Session's request range: not a
     * seq of the log, or a seq before the first model request settled.
     */
    'loom/seq-out-of-range': {
      readonly sessionId: SessionId
      /** The seq the caller named. */
      readonly seq: number
      /** Seqs that address a request, from the first request settlement to the last event; null when no request settled yet. */
      readonly range: { readonly from: SessionSeq; readonly to: SessionSeq } | null
    }
    /** `loom.branch` named a prompt line, or an edit text, without non-whitespace text. */
    'loom/empty-line': {
      /** Zero-based position of the line in `lines`; 0 for an edit. */
      readonly index: number
    }
    /** `loom.branch` asked for more children than the configured `maxBranchesPerRequest`. */
    'loom/too-many-branches': {
      /** Children the request would create. */
      readonly requested: number
      /** Configured `maxBranchesPerRequest`. */
      readonly limit: number
    }
    /** `loom.branch` named a turn it cannot branch from. */
    'loom/turn-unavailable': {
      readonly sessionId: SessionId
      /** The turn the request named. */
      readonly turn: number
      /**
       * `not-found`: the log has no such turn. `not-ended`: a steer or variants
       * request named a turn that has no `turn/end`. `not-user-opened`: a
       * regenerate or edit request named a turn whose opening prompt did not
       * come from a user. `no-cut`: no fork cut keeps the history before the
       * turn, because the log's first event admits its opening prompt.
       */
      readonly reason: 'not-found' | 'not-ended' | 'not-user-opened' | 'no-cut'
    }
    /**
     * `loom.setStatus` or `loom.cancel` named a set this Host does not hold:
     * unknown, created through a Session outside the caller's access, or
     * created before the Host restarted.
     */
    'loom/set-not-found': {
      readonly setId: LoomSetId
    }
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

/** Read of the model request in force at one event of a Session. */
export interface LoomRequestAtRequest {
  /** Session whose log holds the event. */
  readonly sessionId: SessionId
  /**
   * Any event of the Session. The view describes the latest model request
   * whose settlement, an `assistant/message` or `assistant/attempt`, is at or
   * before this seq; a settlement's own seq addresses that request.
   */
  readonly seq: SessionSeq
}

/** Provider route the request was sent on, from the `request/header` in force. */
export interface LoomRequestRoute {
  readonly provider: string
  readonly model: string
  /** Reasoning effort id, absent when the request named none. */
  readonly reasoningEffort?: string
}

/**
 * Effective system prompt of the request: the text of its last nonempty
 * `system/message` node. Earlier system nodes stay in `messages`.
 */
export interface LoomRequestSystemPrompt {
  /** Length of `text` in Unicode code points. */
  readonly chars: number
  /** Complete prompt text; empty when the request carried no system prompt. */
  readonly text: string
  /**
   * Turn whose step wrote the system node that carries `text`; absent when
   * that node is the Session's first system prompt or no prompt exists.
   */
  readonly changedAtTurn?: number
}

/** Tool catalog of the request. */
export interface LoomRequestTools {
  /** Tool names in request order. */
  readonly names: readonly string[]
  /**
   * Tools that `developer/message` tool additions activated in the request's
   * turn, up to the request, in log order without repeats. The first request
   * of a Session logs no additions, so its catalog appears only in `names`.
   */
  readonly addedThisTurn: readonly string[]
  /** Tools that `developer/message` tool removals withdrew in the request's turn, up to the request. */
  readonly removedThisTurn: readonly string[]
}

/** One message of the request, in model-visible order. */
export interface LoomRequestMessage {
  /** Surface event that produced the message. */
  readonly seq: SessionSeq
  /** Message role; a developer message, which carries tool additions and removals, is reported as `system`. */
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  /** Whether the Session inherited the producing event from its fork source (`seq` below its inherited event count). */
  readonly inherited: boolean
  /**
   * Start of the message text with whitespace runs collapsed to one space,
   * at most `LOOM_REQUEST_PREVIEW_MAX_CODE_POINTS` code points, ending
   * in `…` when cut.
   */
  readonly preview: string
  /** Length of the complete message text in Unicode code points. */
  readonly chars: number
}

/**
 * What the model received in one request, rebuilt from the Session log: the
 * route and tools of the `request/header` in force, the effective system
 * prompt, and every message of the request, split at the fork cut. Message
 * text renders text and reasoning blocks verbatim, a tool call as its name
 * and raw arguments, a tool addition as `+name`, a tool removal as `-name`,
 * and an image or file as its name in brackets, one block per line.
 */
export interface LoomRequestView {
  readonly route: LoomRequestRoute
  readonly systemPrompt: LoomRequestSystemPrompt
  readonly tools: LoomRequestTools
  readonly messages: readonly LoomRequestMessage[]
  /** Turns started before the request in the inherited prefix. */
  readonly inheritedTurns: number
  /** Turns the Session started itself before the request, its current turn included. */
  readonly ownTurns: number
}

/** Fields every `loom.branch` request carries. */
export interface LoomBranchRequestBase {
  /**
   * Session the request addresses. Children are forked from it, except that a
   * regenerate or edit of the first turn a fork Session started itself forks
   * that fork's parent at the fork's cut, which requires `loom/branch` access
   * to the parent as well; when that parent no longer exists, the children are
   * forked from the addressed fork instead, below it. No source Session is written.
   */
  readonly sessionId: SessionId
  /** Retry identity; a second call with the same identity for the same Session returns the first result and creates nothing. */
  readonly requestId: LoomBranchRequestId
  /**
   * Route for each child's next request, recorded in the child only and never
   * saved as the default. Omission keeps the route the Session Controller's
   * fork gives the child; for a regenerate or edit forked from a fork's parent,
   * omission selects the last route the fork selected before that turn. The
   * Session Controller validates the route in each child's fork, so an
   * unavailable one fails each child, not the request, with `session/model-unavailable`.
   */
  readonly selection?: ModelSelection
}

/**
 * Regenerate turn `turn` `count` times: each child is cut before the turn's
 * opening prompt and sent that prompt again unchanged. When `turn` is the
 * first turn a fork Session started itself, the children are forked from the
 * fork's parent at the fork's cut instead, beside the fork; when that parent
 * no longer exists, they are forked from the addressed fork, below it.
 */
export interface LoomRegenerateRequest extends LoomBranchRequestBase {
  readonly kind: 'regenerate'
  /** Turn whose opening user prompt each child receives again. */
  readonly turn: number
  /** Number of children, a positive integer. */
  readonly count: number
}

/** Branch once per line after turn `afterTurn`: each child is cut at the end of that turn and sent its line as its prompt. */
export interface LoomSteerRequest extends LoomBranchRequestBase {
  readonly kind: 'steer'
  /** Last turn every child keeps. */
  readonly afterTurn: number
  /** One prompt per child, in child order and sent verbatim; at least one. */
  readonly lines: readonly string[]
}

/**
 * Edit the opening prompt of turn `turn` into one child: the child is cut
 * before that prompt and sent it with its text parts replaced by `text`;
 * image and file parts keep their stored references. When `turn` is the first
 * turn a fork Session started itself, the child is forked from the fork's
 * parent at the fork's cut instead, beside the fork; when that parent no
 * longer exists, it is forked from the addressed fork, below it.
 */
export interface LoomEditRequest extends LoomBranchRequestBase {
  readonly kind: 'edit'
  /** Turn whose opening user prompt is edited. */
  readonly turn: number
  /** Replacement text. */
  readonly text: string
}

/**
 * Sample each line `samples` times after turn `afterTurn`: `lines.length ×
 * samples` children cut at the end of that turn, ordered line by line, every
 * sample of one line sharing a `variantKey`.
 */
export interface LoomVariantsRequest extends LoomBranchRequestBase {
  readonly kind: 'variants'
  /** Last turn every child keeps. */
  readonly afterTurn: number
  /** Prompt lines, sent verbatim; at least one. */
  readonly lines: readonly string[]
  /** Children per line, a positive integer. */
  readonly samples: number
}

/** One `loom.branch` request. */
export type LoomBranchRequest = LoomRegenerateRequest | LoomSteerRequest | LoomEditRequest | LoomVariantsRequest

/**
 * One child of a branch set when `loom.branch` returned. `started`: the child
 * Session exists and holds its branch record, and its prompt was sent.
 * `queued`: no Session exists yet and the child waits for a concurrency slot.
 * `failed`: the child did not start; `sessionId` is present when its Session
 * was created before the failure, for example when the fork could not attach
 * it to the source's Workspace. `cancelled`: the Loom service unloaded while
 * the call waited for the set's first admissions, and withdrew this queued
 * child; it never gets a Session.
 */
export type LoomBranchChild =
  | { readonly index: number; readonly state: 'started'; readonly sessionId: SessionId }
  | { readonly index: number; readonly state: 'queued' }
  | { readonly index: number; readonly state: 'cancelled' }
  | {
    readonly index: number
    readonly state: 'failed'
    /** RemoteError code of the failure; `gateway/internal` for a failure that carried none. */
    readonly code: RemoteErrorCode
    /** Host diagnostic of the failure. */
    readonly message: string
    /** Child Session, present when it was created before the failure. */
    readonly sessionId?: SessionId
  }

/** Result of one `loom.branch` call. */
export interface LoomBranchValue {
  /** The set the call created. */
  readonly setId: LoomSetId
  /** Every child of the set in request order. */
  readonly children: readonly LoomBranchChild[]
}

/** Read of one branch set. */
export interface LoomSetStatusRequest {
  readonly setId: LoomSetId
}

/**
 * Lifecycle of one child in Host memory, the states of {@link LoomBranchChild}:
 * `cancelled` is a queued child that `loom.cancel` or the service's unloading
 * withdrew before it had a Session.
 */
export type LoomSetChildState = 'started' | 'queued' | 'failed' | 'cancelled'

/** One child of a branch set as the Host holds it. */
export interface LoomSetStatusChild {
  /** Request index. */
  readonly index: number
  readonly state: LoomSetChildState
  /** Child Session; present for a `started` child and for a `failed` child whose Session was created before the failure. */
  readonly sessionId?: SessionId
  /** RemoteError code of the failure; present exactly when `state` is `failed`. */
  readonly code?: RemoteErrorCode
  /** Host diagnostic of the failure; present exactly when `state` is `failed`. */
  readonly message?: string
}

/** Current state of every child of one branch set, held in Host memory only. */
export interface LoomSetStatus {
  readonly setId: LoomSetId
  /**
   * Session every child was forked from: the addressed Session, or its fork
   * parent for a first-own-turn regenerate or edit whose parent still exists.
   */
  readonly sourceSessionId: SessionId
  /** Every child in request order. */
  readonly children: readonly LoomSetStatusChild[]
}

/** Withdrawal of queued children of one branch set. */
export interface LoomCancelRequest {
  readonly setId: LoomSetId
  /** Children to withdraw, by index; omission names every child. Only queued children are withdrawn. */
  readonly indices?: readonly number[]
}

/** Children one `loom.cancel` call withdrew. */
export interface LoomCancelValue {
  /** Indices of the queued children this call withdrew, ascending. */
  readonly cancelled: readonly number[]
}

/** Mark change for one Session. */
export interface LoomMarkRequest {
  readonly sessionId: SessionId
  /** New mark, or null to clear it. */
  readonly mark: LoomMark | null
}

/** Mark in force after a `loom.mark` call. */
export interface LoomMarkValue {
  readonly mark: LoomMark | null
}
