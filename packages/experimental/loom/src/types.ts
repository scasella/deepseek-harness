/** JSON-safe Loom identities, plugin records, projection values, and `loom` Remote inputs and results. */
export type * from './s6-types.ts'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-projection/types'
import type { RemoteErrorCode } from '@deepseek-ai/dsh-typert-protocol'
import type { LoomPrefixSpan } from './s6-types.ts'

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
 * Where a branch child's files live. `shared`: the source's folder, which its
 * siblings and the source also write. `worktree`: a Git worktree of its own,
 * which Loom created for it from the source folder.
 */
export type LoomIsolation = 'shared' | 'worktree'

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

/**
 * Worktree a branch child runs in, written into the child after its fork and
 * before its first prompt. Only Sessions holding this record own a worktree
 * that Loom removes.
 */
export interface LoomIsolationRecord {
  /** Record payload version; readers ignore other versions. */
  readonly version: 1
  /** Commit the worktree started from: the source folder's HEAD plus its uncommitted tracked changes when the set was branched. */
  readonly baseCommit: string
  /** Canonical absolute directory of the worktree. */
  readonly worktreePath: string
  /** Git branch the worktree holds. */
  readonly branchName: string
  /** Canonical root of the source checkout the worktree belongs to, which `loom.apply` writes. */
  readonly repositoryRoot: string
}

/** End of the worktree a {@link LoomIsolationRecord} names, written when Loom removed it. */
export interface LoomIsolationEndRecord {
  /** Record payload version; readers ignore other versions. */
  readonly version: 1
  /** `applied`: `loom.apply` copied its change to the source folder first. `discarded`: `loom.discard` removed it. */
  readonly reason: 'applied' | 'discarded'
}

/** Adoption of the Session that holds it as the line to continue, written by `loom.adopt`. */
export interface LoomAdoptRecord {
  /** Record payload version; readers ignore other versions. */
  readonly version: 1
  /** Branch set whose other members `loom.adopt` archived; absent for a fork that belongs to no set. */
  readonly setId?: LoomSetId
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Branch-set membership of the Session that holds it, written before its first prompt and never model-visible. */
    'plugin:loom/branch': LoomBranchRecord
    /** Private keep or set-aside mark of the Session that holds it; never model-visible and never a feedback event. */
    'plugin:loom/mark': LoomMarkRecord
    /** Worktree of the branch child that holds it, written before its first prompt and never model-visible. */
    'plugin:loom/isolation': LoomIsolationRecord
    /** Removal of the worktree the same Session's `plugin:loom/isolation` record names; never model-visible. */
    'plugin:loom/isolation-end': LoomIsolationEndRecord
    /** Adoption of the Session that holds it; never model-visible. */
    'plugin:loom/adopt': LoomAdoptRecord
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
  /** Present when the Session holds an own `plugin:loom/adopt` record after its membership. */
  readonly adopted?: true
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

/** Own request usage grouped by logged route; prices are applied only when a Host reads the state. */
export interface LoomPriceUsageState {
  /** Fork-inherited prefix length. */
  readonly inheritedEventCount: number
  /** Latest request header route, or null before the first header. */
  readonly route: { readonly provider: string; readonly model: string } | null
  /** Whether any own settlement lacked a route or provider usage. */
  readonly incomplete: boolean
  /** Own token totals per provider/model. */
  readonly routes: readonly {
    readonly provider: string
    readonly model: string
    readonly uncachedInputTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
    readonly outputTokens: number
  }[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host-only own request usage by route, independent of configured prices. */
    loomPriceUsage: LoomPriceUsageState
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
    /**
     * `loom.branch` asked for `isolation: 'worktree'` and the Host cannot give
     * each child a worktree; raised before any fork.
     */
    'loom/isolation-unavailable': {
      readonly reason: LoomIsolationUnavailableReason
    }
    /** `loom.compare` or `loom.adopt` named a Session that has no fork parent, and no set. */
    'loom/not-a-fork': {
      readonly sessionId: SessionId
    }
    /** `loom.apply` found tracked changes in the source folder; nothing was written. */
    'loom/apply-dirty': {
      /** Source paths with staged or unstaged changes, relative to the source folder. */
      readonly paths: readonly string[]
    }
    /** `loom.apply` found that the branch's change does not apply to the source folder; nothing was written. */
    'loom/apply-conflict': {
      /** Paths whose change does not apply, relative to the source folder; empty when Git named none. */
      readonly paths: readonly string[]
    }
    /** `loom.apply` named a Session that shares the source folder, so it has no change to copy. */
    'loom/apply-not-isolated': {
      readonly sessionId: SessionId
    }
    /** `loom.apply` found a change larger than the configured `apply.maxPatchBytes`; nothing was written. */
    'loom/apply-too-large': {
      readonly sessionId: SessionId
      /** Configured `apply.maxPatchBytes`. */
      readonly limit: number
    }
    /**
     * `loom.diff`, `loom.apply`, or `loom.discard` named a Session without a
     * worktree to read or remove. `shared`: it never had one. `removed`: Loom
     * already removed it. `missing`: its repository no longer registers it.
     */
    'loom/worktree-unavailable': {
      readonly sessionId: SessionId
      readonly reason: 'shared' | 'removed' | 'missing'
    }
    /**
     * `loom.diff` named a shared-folder Session whose changes this Host does not
     * hold: no changes service is composed, or the Session is not live here.
     */
    'loom/diff-unavailable': {
      readonly sessionId: SessionId
    }
    /**
     * `loom.apply` wrote the change into the source folder and then could not
     * remove the worktree, which stays until `loom.discard` succeeds.
     */
    'loom/worktree-cleanup-failed': {
      readonly sessionId: SessionId
      readonly worktreePath: string
      /** Source paths the change wrote. */
      readonly applied: readonly string[]
    }
    /**
     * `loom.adopt` recorded the adoption and archived only some siblings; a
     * retry archives the rest.
     */
    'loom/adopt-incomplete': {
      readonly sessionId: SessionId
      /** Siblings archived, including those archived before the call. */
      readonly archived: readonly SessionId[]
      /** Siblings not archived. */
      readonly remaining: readonly SessionId[]
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
  /**
   * Where each child's files live; omission takes the configured
   * `defaultIsolation`. `worktree` needs the experimental worktree service, a
   * sandbox mode at the cut that can write, and a Git repository whose root is
   * the source folder (or at or above it under `danger-full-access`); it is
   * refused with `loom/isolation-unavailable` before any fork otherwise. Each
   * child then gets a worktree started from one commit per set: the source
   * folder's HEAD plus its uncommitted tracked changes, captured when the set's
   * first child is admitted. Untracked files are not carried.
   */
  readonly isolation?: LoomIsolation
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

/**
 * Why `loom.branch` cannot isolate children in worktrees. `service-unavailable`:
 * the experimental worktree service is not composed. `read-only`: the sandbox
 * mode at the cut cannot write. `no-repository`: no Git repository contains the
 * source's folder at the cut. `subdirectory`: the repository root lies above the
 * source folder, outside the writes a confined mode allows. `linked-checkout`:
 * the source folder is a linked checkout or submodule whose Git data lies
 * elsewhere, outside the writes a confined mode allows.
 */
export type LoomIsolationUnavailableReason = 'service-unavailable' | 'read-only' | 'no-repository' | 'subdirectory' | 'linked-checkout'

/** Siblings to compare: those at one Session's fork cut, or the members of one branch set. */
export interface LoomCompareRequest {
  /**
   * A fork whose cut names the siblings, itself included; with `setId`, the
   * set's source Session, any member, or a fork beside the set whose first
   * own turn the set regenerated or edited.
   */
  readonly sessionId: SessionId
  /** Restrict the rows to the members of this set. */
  readonly setId?: LoomSetId
}

/** Test outcome found in a branch's own command output by a configured `outcomes.testSummary` pattern. */
export interface LoomCompareTests {
  readonly passed: number
  /** Failed tests plus errors. */
  readonly failed: number
  /** Every test the summary counted, skipped ones included. */
  readonly total: number
  /** Whether nothing failed and at least one test ran. */
  readonly ok: boolean
  /** Command whose output held the summary, from the call's configured command argument. */
  readonly command: string
}

/** One file a branch changed. */
export interface LoomCompareDiffFile {
  /** Path relative to the worktree root, or the changes service's display path for a shared folder. */
  readonly path: string
  /** Added lines; 0 for a binary file. */
  readonly insertions: number
  /** Deleted lines; 0 for a binary file. */
  readonly deletions: number
}

/** Files a branch changed and where they were read. */
export interface LoomCompareDiff {
  /** Changed files in path order. */
  readonly files: readonly LoomCompareDiffFile[]
  readonly insertions: number
  readonly deletions: number
  /**
   * `worktree`: Git, from the worktree against its base commit, untracked files
   * included. `workspace-changes`: the per-turn summaries of the branch's own
   * turns, summed per file.
   */
  readonly source: 'worktree' | 'workspace-changes'
}

/** A branch's own usage, which excludes everything it inherited at its fork. */
export interface LoomCompareOwn {
  /** Own closed steps. */
  readonly steps: number
  /** Own input tokens the provider did not serve from cache, cache writes included. */
  readonly inputTokens: number
  /** Own input tokens served from cache. */
  readonly cachedTokens: number
  readonly outputTokens: number
  /** List-price cost of the own tokens, present only when the route has a configured price. */
  readonly usd?: { readonly amount: number; readonly label: 'list price' }
}

/** One sibling of a compare. */
export interface LoomCompareRow {
  readonly sessionId: SessionId
  /** Latest Session title; empty when the Session has none. */
  readonly title: string
  /** Text of the Session's first own user prompt; empty when it has none yet. */
  readonly prompt: string
  /** The set kind that created the Session, or `fork` for a fork that belongs to no set. */
  readonly kind: LoomBranchKind | 'fork'
  readonly isolation: LoomIsolation
  /** Whether Loom has applied or discarded this isolated worktree; absent for shared folders. */
  readonly worktreeEnded?: boolean
  /** Whether the Session's Agent was running when listed. */
  readonly running: boolean
  /** The last test summary in the Session's own command output; absent when none matched. */
  readonly tests?: LoomCompareTests
  /**
   * Changed files; absent when they cannot be read: a removed or missing
   * worktree, or a shared folder whose changes this Host does not hold.
   */
  readonly diff?: LoomCompareDiff
  readonly own: LoomCompareOwn
  /** Summed duration of the Session's own ended turns; absent before its first own turn ends. */
  readonly wallMs?: number
  /** Private mark, when set. */
  readonly mark?: LoomMark
  /** Whether the Session holds an own `plugin:loom/adopt` record. */
  readonly adopted: boolean
}

/** Siblings at one fork cut. */
export interface LoomCompareValue {
  /** Session every row was forked from. */
  readonly parent: SessionId
  /** Last parent event every row inherited. */
  readonly cutSeq: SessionSeq
  /** Last turn every row inherited complete; absent for a cut before the first `turn/end`. */
  readonly cutTurn?: number
  /** Siblings the caller may reach, ordered by creation time, then by set and request index, then by Session id. */
  readonly rows: readonly LoomCompareRow[]
}

/** Unified diff of one branch, or of one of its files. */
export interface LoomDiffRequest {
  readonly sessionId: SessionId
  /** One changed file, by the path `loom.compare` reports; omission names every changed file. */
  readonly path?: string
}

/** Unified diff text of a branch. */
export interface LoomDiffValue {
  /** Git-style unified diff, file after file in path order; empty when nothing changed. */
  readonly unified: string
  /** Whether files were left out to stay within the configured `diff.maxBytes`. */
  readonly truncated: boolean
}

/** Adoption of one branch as the line to continue. */
export interface LoomAdoptRequest {
  readonly sessionId: SessionId
}

/** The adopted branch and the siblings now archived. */
export interface LoomAdoptValue {
  readonly adopted: SessionId
  /** Every sibling archived, including those archived before the call. */
  readonly archived: readonly SessionId[]
}

/** Copy of a worktree branch's change into the source folder. */
export interface LoomApplyRequest {
  readonly sessionId: SessionId
}

/** Files the change wrote into the source folder. */
export interface LoomApplyValue {
  /** Changed paths relative to the source folder, in path order. */
  readonly applied: readonly { readonly path: string }[]
}

/** Removal of the worktree Loom created for one branch. */
export interface LoomDiscardRequest {
  readonly sessionId: SessionId
}

/** The removed worktree. */
export interface LoomDiscardValue {
  readonly worktreePath: string
  readonly branchName: string
}

/** A model tool whose results count as command output for test summaries. */
export interface LoomCommandTool {
  /** Tool name as the model calls it. */
  readonly name: string
  /** String argument of the call that holds the command, reported as `tests.command`. */
  readonly commandArgument: string
}

/**
 * One way to find a test summary in command output. Every field is a
 * JavaScript regular expression source. `summary` matches the summary text,
 * with `^` and `$` matching at line boundaries; each count pattern is then
 * searched in the matched text, and its first capture group is the count.
 */
export interface LoomTestSummaryPattern {
  /** Label of the pattern in diagnostics. */
  readonly name: string
  /** Summary text pattern. */
  readonly summary: string
  /** Passed tests; omission derives them from the total. */
  readonly passed?: string
  /** Failed tests. */
  readonly failed?: string
  /** Errors, counted as failed tests. */
  readonly errors?: string
  /** Skipped tests, counted in the total only. */
  readonly skipped?: string
  /** All tests; omission adds passed, failed, errors, and skipped. */
  readonly total?: string
}

/**
 * List prices of one provider route in US dollars per million tokens. A row
 * prices cache reads at `inputHitPerMTok`, uncached input and cache writes at
 * `inputMissPerMTok`, and output, reasoning tokens included, at `outputPerMTok`.
 */
export interface LoomPriceRow {
  /** Registered provider route, as a request header names it. */
  readonly provider: string
  /** Provider-owned model id, as a request header names it. */
  readonly model: string
  /** Price of one million input tokens the provider did not serve from cache. */
  readonly inputMissPerMTok: number
  /** Price of one million input tokens the provider served from cache. */
  readonly inputHitPerMTok: number
  /** Price of one million output tokens. */
  readonly outputPerMTok: number
}

interface LoomEstimateCommon {
  /** Session the generation request would address. */
  readonly sessionId: SessionId
  /** Siblings the request would create, within the operation's configured limit. */
  readonly count: number
  /** Route to price; recorded token evidence must still identify its source route. */
  readonly selection?: ModelSelection
}

/** Cost preview of one Session branch request. */
export interface LoomBranchEstimateRequest extends LoomEstimateCommon {
  /** What the branch request would do. */
  readonly kind: LoomBranchKind
  /** Turn a `regenerate` or `edit` repeats; required for those kinds. */
  readonly turn?: number
  /** Last turn a `steer` or `variants` set keeps; required for those kinds. */
  readonly afterTurn?: number
}

/** Prose cost preview from historical input usage and the requested output cap. */
export interface LoomWeaveEstimateRequest extends LoomEstimateCommon {
  readonly kind: 'weave'
  /** Output tokens priced per continuation; defaults to the configured Weave cap and cannot exceed it. */
  readonly maxTokens?: number
  /** Exact cursor prefix, used to prefer matching recorded input usage; no token count is guessed from its text. */
  readonly prefix?: readonly LoomPrefixSpan[]
}

/** Cost preview of Session branching or auxiliary prose generation. */
export type LoomEstimateRequest = LoomBranchEstimateRequest | LoomWeaveEstimateRequest

/** Low and high figure of one estimate. */
export interface LoomEstimateRange {
  readonly low: number
  readonly high: number
}

/**
 * Cost preview of a branch request, from tokens the Sessions already used.
 * With `priced`, the ranges are US dollars at the route's configured list
 * price: `low` prices every input token at the cache-hit price (a warm
 * prefix), `high` at the cache-miss price (a cold one), and output at the
 * output price in both. Without it, no price is configured for the route, and
 * the ranges are the basis's total tokens, input and output together, with
 * `low` equal to `high`. Weave prices the requested full output cap at both
 * endpoints instead of historical output. A basis with no recorded usage has no ranges.
 */
export interface LoomEstimateValue {
  /** Whether the route has a configured price, so the ranges are dollars and not tokens. */
  readonly priced: boolean
  /** One child. */
  readonly perBranch?: LoomEstimateRange
  /** `count` children: `count` times `perBranch`. */
  readonly total?: LoomEstimateRange
  /** Share of the basis's input tokens served from cache, from 0 to 1; 0 without a basis. */
  readonly cacheShare: number
  /**
   * `own-turn`: the turn being repeated. `family`: the average own turn of the
   * Session's fork family, which also stands in for a repeated turn with no
   * recorded usage. `weave-history`: reported input from an own Weave request
   * on the selected route, priced at the requested output cap.
   */
  readonly basis: 'own-turn' | 'family' | 'weave-history'
  /** Full output limit used in both cache-price endpoints of a Weave estimate. */
  readonly outputCap?: number
  /** Historical input evidence; absent without an own reported Weave settlement on the selected route. */
  readonly historicalInput?: {
    readonly requestSeq: SessionSeq
    readonly samples: number
    readonly provider: string
    readonly model: string
    /** Whether this recorded request used the exact joined cursor prefix supplied for the preview. */
    readonly prefixMatches: boolean
  }
}
