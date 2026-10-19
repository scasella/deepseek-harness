# Loom

English | [中文](loom.zh.md)

The experimental [Loom service](../../packages/experimental/loom/README.md) treats forked Sessions as a tree. A fork Session copies an exact event prefix of its source and records the source as its parent; Loom reads that tree, creates branch children through the Session Controller's fork, optionally in Git worktrees of their own, compares and adopts them, and adds branch membership, isolation, adoption, and private marks as experimental plugin records. The [Loom interface Agent Note](../../.agents/notes/implemented/feature/2026-10-18-loom-interface.md) owns the staged plan.

## Fork families

`LoomFamily` is the fork family of one Session as derived from a Session list: `rootId` names the highest listed fork ancestor, `focusId` the requested Session, and `nodes` every listed fork descendant of the root in depth-first order, siblings in creation order and then by Session id. A `LoomFamilyNode` carries a branded `LoomNodeId` whose text is the Session id, the Session id itself, its parent node, its depth, the creation time from the row's `forkLineage` list hint when present, and the list facts `updatedAt`, `running`, and `blank`. A subagent parent link is not a fork link. The browser derives families from its client Session list through the `@deepseek-ai/dsh-experimental-loom/family` export; the Host `family()` read serves other callers, and `LoomFamilyRequest` names any member of the family.

## Branch sets

`LoomBranchRequest` is one of four requests, each naming the source `sessionId`, a branded `LoomBranchRequestId` for retries, and an optional `ModelSelection` route: `LoomRegenerateRequest` and `LoomEditRequest` cut before the prompt that opened a turn and re-send it, unchanged or with its text replaced, except that for the first turn a fork Session started itself they fork the fork's parent at the fork's cut, on the fork's route unless the request names one, so the children become further variants beside the fork, or, when that parent no longer exists, cut in the fork itself, below it; `LoomSteerRequest` and `LoomVariantsRequest` cut at the end of a turn and send each line, the variants once per sample. The runner forks a child only when a concurrency slot admits it, removes the next-turn prompts the child inherited from the cut, writes the child's branch record, and then sends its prompt. `LoomBranchValue` lists each `LoomBranchChild` as `started` with its Session, `queued` without one, `failed` with a RemoteError code and message, or `cancelled` when the service unloaded during the call and withdrew it. `LoomSetStatus` reads the same Host memory for a `LoomSetId`, where `cancelled` also marks queued children that `LoomCancelRequest` withdrew; the memory does not survive a Host restart, so a set from before it reports `loom/set-not-found`.

## Worktree isolation

`LoomIsolation` chooses where a branch child keeps its files: `shared` uses the source's folder, and `worktree` gives each child a [Git worktree](worktrees.md) created from one base commit per set, the source folder's HEAD plus its uncommitted tracked changes. `LoomBranchRequestBase.isolation` names it per request, defaulting to the Loom `Config`'s `defaultIsolation`. A request the Host cannot isolate fails before any fork with `loom/isolation-unavailable`, whose `LoomIsolationUnavailableReason` is `service-unavailable`, `read-only`, `no-repository`, `subdirectory`, or `linked-checkout`. Worktree children run without the one-writer-per-folder rule.

## Compare and diff

`LoomCompareRequest` names a fork, whose cut selects its siblings, or a set and any of its members or its source. `LoomCompareValue` holds the parent, the cut, and one `LoomCompareRow` per reachable sibling, read from the sibling's own log: its title and first own prompt, its `LoomBranchKind` or `fork`, its isolation, whether it runs, its `LoomCompareTests` from its own command output, its `LoomCompareDiff` from Git or from its own turns' change summaries, its `LoomCompareOwn` steps and tokens, its wall time, its mark, and whether it was adopted. `LoomTestSummaryPattern` and `LoomCommandTool` configure the test outcomes. `LoomDiffRequest` returns a `LoomDiffValue` with the unified diff of one branch, or of one of its files, and whether files were left out.

## Adopt, apply, and discard

`LoomAdoptRequest` adopts one fork: `plugin:loom/adopt` is written into it, and its siblings, the other members of its set or the other forks at its cut, are archived through the Workspace registry; `LoomAdoptValue` lists them. `LoomApplyRequest` copies an idle worktree child's change into the source folder with `git apply` and removes the worktree; `LoomApplyValue` lists the written paths, and `loom/apply-dirty`, `loom/apply-conflict`, `loom/apply-too-large`, and `loom/apply-not-isolated` refuse it before any write. `LoomDiscardRequest` removes the worktree and returns its path and branch as a `LoomDiscardValue`. Apply and discard touch only the worktree a child's isolation record names.

## Branch membership and marks

`plugin:loom/branch` is a `LoomBranchRecord` that a branch child holds before its first prompt: the `LoomSetId`, the source Session and the inclusive source seq it was cut at, the `LoomBranchKind`, the child's zero-based `index` in request order, and, for a variants child, the `variantKey` digest of its line. The `loomBranch` projection publishes a `LoomBranchView` of `{ setId, kind, index, variantKey?, createdAt }`, or null for a Session that is not a Loom branch child. `plugin:loom/mark` is a `LoomMarkRecord` holding a `LoomMark`, `keep` or `set-aside`, or null to clear it; the `loomMark` projection publishes the last one as a `LoomMarkView`, or null. `plugin:loom/isolation` is a `LoomIsolationRecord` naming a worktree child's base commit, worktree path, branch, and repository root; `plugin:loom/isolation-end` is a `LoomIsolationEndRecord` written when Loom applied or discarded that worktree; and `plugin:loom/adopt` is a `LoomAdoptRecord`, after which the `LoomBranchView` carries `adopted: true`. Only records at or after the Session's inherited event count count, so a fork of a branch or of a marked Session starts with neither. Marks are never feedback events, and telemetry export removes the payload of every `plugin:loom/*` record.

## What the model saw

`LoomRequestAtRequest` names a Session and any event seq. `LoomRequestView` describes the latest model request whose `assistant/message` or `assistant/attempt` settlement is at or before that seq, rebuilt from the whole log the way the agent loop derives it: a `LoomRequestRoute` and the tool names from the `request/header` in force, a `LoomRequestTools` with the tool additions and removals that `developer/message` events logged in the request's turn, a `LoomRequestSystemPrompt` with the effective system prompt and the turn that wrote it when it changed after the first prompt, and one `LoomRequestMessage` per request message with its producing seq, role, inherited flag, bounded preview, and length. `inheritedTurns` and `ownTurns` split the turns started before the request at the fork cut. The view is the request the loop built before the provider route projects it, so a route without tool-update support does not receive the developer rows. A seq outside the log or before the first settlement fails with `loom/seq-out-of-range`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxloom--loom"></a>

### `ctx.loom` — `Loom`

Loom Host service. It registers the `loomBranch` and `loomMark` projection units, the telemetry redaction rule for `plugin:loom/*` records, the branch runner, and the compare, diff, adopt, apply, and discard operations for its own lifetime, and exposes the `loom` Remote namespace.

```ts cordis-catalog
/**
 * Read the fork family of one visible Session from the current Session list
 * without activating any Agent. The Gateway authorizes the addressed Session
 * through the `sessionId` field the Session Controller registers as the
 * `session` resource, and the result keeps only Sessions the caller may list.
 * It serves callers without a Session list of their own; the Loom browser
 * plugin derives families from its client Session list instead.
 * @param request - any member of the family.
 * @param signal - cancellation for the list read.
 * @returns the visible family rooted at the highest visible fork ancestor.
 * @throws RemoteError `session/not-found` when the caller cannot list the Session.
 */
@Remote async family(request: LoomFamilyRequest, signal: AbortSignal): Promise<LoomFamily>

/**
 * Rebuild the model request in force at one event of a Session from its
 * whole log, without activating its Agent: the latest request whose
 * `assistant/message` or `assistant/attempt` settlement is at or before
 * `seq`, with its route, tools, effective system prompt, and messages split
 * at the fork cut. The Gateway authorizes the addressed Session through the
 * `sessionId` field the Session Controller registers as the `session`
 * resource, so a caller without access fails with `remote-access/denied`
 * before this method runs.
 * @param request - Session and event to read.
 * @param signal - cancellation for the Session read.
 * @returns the request view.
 * @throws RemoteError `session/not-found` when the Session does not exist.
 * @throws RemoteError `loom/seq-out-of-range` when `seq` is not a seq of the log or precedes the first request settlement.
 * @throws RemoteError `gateway/internal` when the log holds no `request/header` before the addressed request.
 */
@Remote async requestAt(request: LoomRequestAtRequest, signal: AbortSignal): Promise<LoomRequestView>

/**
 * Fork a current tool result, replace only its content, then continue the child.
 * The original tool metadata and success/error classification are retained.
 * @param request - source Session, current result and replacement text.
 * @param signal - cancellation before child continuation admission.
 * @returns the new branch and its content replacement event.
 */
@Remote counterfactual(request: LoomCounterfactualRequest, signal: AbortSignal): Promise<LoomCounterfactualValue>

/**
 * Generate prose siblings at a cursor without changing Chat history.
 * @param request - cursor, authored prefix, sibling count and generation controls.
 * @param signal - caller cancellation.
 * @returns settled siblings in dispatch order, including failures.
 */
@Remote weave(request: LoomWeaveRequest, signal: AbortSignal): Promise<LoomWeaveValue>

/**
 * Read a persisted prose document without activating an Agent.
 * @param request - Session whose prose records to read.
 * @param signal - caller cancellation.
 * @returns generated nodes, current choices and curation totals.
 */
@Remote weaveState(request: LoomWeaveStateRequest, signal: AbortSignal): Promise<LoomWeaveState>

/**
 * Select one completed prose continuation and retain its curation credit.
 * @param request - Session and chosen node.
 * @param signal - caller cancellation.
 * @returns current curation bits and selected model-token count.
 */
@Remote choose(request: LoomChooseRequest, signal: AbortSignal): Promise<LoomCurationValue>

/**
 * Explore next-token alternatives within configured breadth and depth limits.
 * @param request - prose cursor and optional tighter controls.
 * @param signal - caller cancellation.
 * @returns captured alternatives and request-budget status.
 */
@Remote probe(request: LoomProbeRequest, signal: AbortSignal): Promise<LoomProbeValue>

/**
 * Prepare an owner-authenticated prose or agent-branch download.
 * @param request - path, sibling set or kept branches and optional output format.
 * @param signal - caller cancellation.
 * @returns the immutable download URL and filename; the snapshot expires by configuration.
 */
@Remote export(request: LoomExportRequest, signal: AbortSignal): Promise<LoomExportValue>

/**
 * Branch one Session into a set of fork children, each cut at the request's
 * turn boundary and sent its own prompt. A regenerate or edit of the first
 * turn a fork Session started itself forks that fork's parent at the fork's
 * cut instead, so the children become further variants beside the fork.
 * Without a `selection`, those children take the route the fork selected
 * before that turn. When that parent no longer exists, the children are cut
 * in the addressed fork instead, below it. Every request validation runs
 * before any fork, except that the Session Controller validates `selection`
 * in each child's fork, so an unavailable route fails each child with
 * `session/model-unavailable` and not the request. A child is
 * forked only when a concurrency slot admits it, so a queued child has no
 * Session; the runner removes the next-turn prompts the child inherited from
 * the cut, writes its `plugin:loom/branch` record, and then sends its
 * prompt. A retry with the same `requestId` for the same Session returns the
 * first result. The Gateway authorizes the addressed Session through its
 * `sessionId` field; the method itself requires `loom/branch` on a fork
 * parent it branches instead.
 * @param request - addressed Session, cut, prompts, and optional route.
 * @returns the set and each child as it stood when the call returned; a child the service's unloading withdrew
 *   meanwhile reads `cancelled`.
 * @throws RemoteError `session/not-found` (the addressed Session), `remote-access/denied`
 *   (the fork parent, while it exists), `gateway/bad-request`, `loom/too-many-branches`, `loom/empty-line`,
 *   `loom/turn-unavailable`, or `gateway/cancelled` (the service unloaded before the set existed), each before
 *   any fork.
 */
@Remote branch(request: LoomBranchRequest): Promise<LoomBranchValue>

/**
 * Branch one Session for a Host caller acting for a model or a plugin:
 * {@link branch} with every validation, admission rule, and retry identity,
 * except that each child's prompt carries `options.source` and
 * `options.prepare` runs on each child before its prompt. It is not a Remote
 * method and authorizes nothing; the caller decides which Sessions it may
 * branch.
 * @param request - addressed Session, cut, prompts, and optional route.
 * @param options - the prompt source and the per-child preparation.
 * @returns the set and each child as it stood when the call returned.
 * @throws RemoteError as {@link branch} does, except `remote-access/denied`.
 */
branchFor(request: LoomBranchRequest, options: LoomHostBranchOptions): Promise<LoomBranchValue>

/**
 * Read the list-price cost of a live Session's own settled requests for a Host budget watcher.
 * Each request uses its logged route; inherited work costs nothing. Reads are incremental and activate no Agent.
 * @param session - live Session to price.
 * @returns USD, or undefined if an own request lacks prices or usage, or no priced route has been logged yet.
 */
ownUsd(session: Session): number | undefined

/**
 * Preview branching from a repeated turn or visible fork family's own usage,
 * or prose from its route's recorded own Weave input and output cap.
 * Ranges are USD at configured list prices when priced, otherwise token counts. The read creates no forks and activates no Agent.
 * The Gateway authorizes the addressed Session through its `sessionId`; family members are filtered by the caller's access.
 * @param request - Session, operation, sibling count, optional route, and turn or prose controls.
 * @param signal - cancellation of Session and projection reads.
 * @returns per-branch and total ranges, cache share, and the source of the token figures.
 * @throws RemoteError `session/not-found`, `gateway/bad-request`, `loom/too-many-branches`, `loom/turn-unavailable`,
 *   `loom/prose-unavailable` for prose limits, or `gateway/internal` when required own usage projections are missing.
 */
@Remote estimate(request: LoomEstimateRequest, signal: AbortSignal): Promise<LoomEstimateValue>

/**
 * Read every child of one branch set from Host memory, which a Host
 * restart clears.
 * @param request - the set.
 * @returns each child's state, Session, and failure.
 * @throws RemoteError `loom/set-not-found` for a set this Host does not hold or whose addressed Session the caller cannot access.
 */
@Remote setStatus(request: LoomSetStatusRequest): LoomSetStatus

/**
 * Withdraw queued children of one branch set before they have a Session.
 * @param request - the set and, optionally, the child indices to withdraw.
 * @returns the indices withdrawn by this call.
 * @throws RemoteError `loom/set-not-found` for a set this Host does not hold or whose addressed Session the caller cannot access.
 */
@Remote cancel(request: LoomCancelRequest): LoomCancelValue

/**
 * Compare the siblings at one fork cut, or the members of one set, by
 * outcome: test summaries from each branch's own command output, changed
 * files, own usage, own wall time, marks, and adoption. Rows cover only
 * Sessions the caller may reach. A worktree row's diff resumes its Session
 * when it is cold. The Gateway authorizes the addressed Session through its
 * `sessionId` field.
 * @param request - a fork, or a set's source or member with the set.
 * @param signal - cancellation of the reads.
 * @returns the parent, the cut, and one row per sibling.
 * @throws RemoteError `session/not-found`, `loom/not-a-fork`, `loom/set-not-found`, or `gateway/internal` when a
 *   sibling's own usage projections are unavailable.
 */
@Remote compare(request: LoomCompareRequest, signal: AbortSignal): Promise<LoomCompareValue>

/**
 * Unified diff of one branch: Git against its base commit for a worktree
 * child, untracked files included, or the change summaries of its own turns
 * for a child that shares the source folder. The Gateway authorizes the
 * Session through its `sessionId` field.
 * @param request - the branch and an optional file.
 * @param signal - cancellation of the reads.
 * @returns the text and whether files were left out to stay within `diff.maxBytes`.
 * @throws RemoteError `session/not-found`, `loom/worktree-unavailable`, or `loom/diff-unavailable`.
 */
@Remote diff(request: LoomDiffRequest, signal: AbortSignal): Promise<LoomDiffValue>

/**
 * Adopt one branch as the line to continue: record `plugin:loom/adopt` in
 * it, then archive its siblings, the other members of its set or the other
 * forks at its cut, through the Workspace registry, stopping their running
 * work first. Nothing is deleted. The Gateway authorizes the branch through
 * its `sessionId` field; the method requires `loom/adopt` on every sibling
 * before any write.
 * @param request - the branch.
 * @returns the branch and every sibling now archived.
 * @throws RemoteError `session/not-found`, `loom/not-a-fork`, `remote-access/denied`, or `loom/adopt-incomplete`.
 */
@Remote adopt(request: LoomAdoptRequest): Promise<LoomAdoptValue>

/**
 * Copy an idle worktree branch's change into the source folder with
 * `git apply`, then remove the worktree. Refused before any write when the
 * source folder has tracked changes, the change does not apply, or it
 * exceeds `apply.maxPatchBytes`. The Gateway authorizes the branch through
 * its `sessionId` field.
 * @param request - the branch.
 * @returns the paths written.
 * @throws RemoteError `session/not-found`, `session/agent-busy`, `loom/apply-not-isolated`, `loom/worktree-unavailable`,
 *   `loom/isolation-unavailable`, `loom/apply-too-large`, `loom/apply-dirty`, `loom/apply-conflict`, or
 *   `loom/worktree-cleanup-failed`.
 */
@Remote apply(request: LoomApplyRequest): Promise<LoomApplyValue>

/**
 * Remove the worktree Loom created for an idle branch, with its files and
 * Git branch; no other worktree is touched. The Gateway authorizes the
 * branch through its `sessionId` field.
 * @param request - the branch.
 * @returns the removed worktree.
 * @throws RemoteError `session/not-found`, `session/agent-busy`, `loom/worktree-unavailable`, or `loom/isolation-unavailable`.
 */
@Remote discard(request: LoomDiscardRequest): Promise<LoomDiscardValue>

/**
 * Set or clear the private mark of one Session, activating it when it is
 * cold, and flush the `plugin:loom/mark` record. A request for the mark the
 * Session already holds writes nothing. Feedback events are never written.
 * The Gateway authorizes the Session through its `sessionId` field.
 * @param request - the Session and its new mark.
 * @returns the mark in force.
 * @throws RemoteError from resolving the Session's Agent, such as `session/not-found`.
 */
@Remote async mark(request: LoomMarkRequest): Promise<LoomMarkValue>
```

Types: [Session](session.md)

Source: [`packages/experimental/loom/src/index.ts`](../../packages/experimental/loom/src/index.ts)
<!-- END GENERATED cordis-surface -->
