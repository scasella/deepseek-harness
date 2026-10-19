# Loom

English | [中文](loom.zh.md)

The experimental [Loom service](../../packages/experimental/loom/README.md) treats forked Sessions as a tree. A fork Session copies an exact event prefix of its source and records the source as its parent; Loom reads that tree, creates branch children through the Session Controller's fork, and adds branch membership and private marks as experimental plugin records. The [Loom interface Agent Note](../../.agents/notes/proposed/feature/2026-10-18-loom-interface.md) owns the staged plan.

## Fork families

`LoomFamily` is the fork family of one Session as derived from a Session list: `rootId` names the highest listed fork ancestor, `focusId` the requested Session, and `nodes` every listed fork descendant of the root in depth-first order, siblings in creation order and then by Session id. A `LoomFamilyNode` carries a branded `LoomNodeId` whose text is the Session id, the Session id itself, its parent node, its depth, the creation time from the row's `forkLineage` list hint when present, and the list facts `updatedAt`, `running`, and `blank`. A subagent parent link is not a fork link. The browser derives families from its client Session list through the `@deepseek-ai/dsh-experimental-loom/family` export; the Host `family()` read serves other callers, and `LoomFamilyRequest` names any member of the family.

## Branch sets

`LoomBranchRequest` is one of four requests, each naming the source `sessionId`, a branded `LoomBranchRequestId` for retries, and an optional `ModelSelection` route: `LoomRegenerateRequest` and `LoomEditRequest` cut before the prompt that opened a turn and re-send it, unchanged or with its text replaced, except that for the first turn a fork Session started itself they fork the fork's parent at the fork's cut, on the fork's route unless the request names one, so the children become further variants beside the fork, or, when that parent no longer exists, cut in the fork itself, below it; `LoomSteerRequest` and `LoomVariantsRequest` cut at the end of a turn and send each line, the variants once per sample. The runner forks a child only when a concurrency slot admits it, removes the next-turn prompts the child inherited from the cut, writes the child's branch record, and then sends its prompt. `LoomBranchValue` lists each `LoomBranchChild` as `started` with its Session, `queued` without one, `failed` with a RemoteError code and message, or `cancelled` when the service unloaded during the call and withdrew it. `LoomSetStatus` reads the same Host memory for a `LoomSetId`, where `cancelled` also marks queued children that `LoomCancelRequest` withdrew; the memory does not survive a Host restart, so a set from before it reports `loom/set-not-found`.

## Branch membership and marks

`plugin:loom/branch` is a `LoomBranchRecord` that a branch child holds before its first prompt: the `LoomSetId`, the source Session and the inclusive source seq it was cut at, the `LoomBranchKind`, the child's zero-based `index` in request order, and, for a variants child, the `variantKey` digest of its line. The `loomBranch` projection publishes a `LoomBranchView` of `{ setId, kind, index, variantKey?, createdAt }`, or null for a Session that is not a Loom branch child. `plugin:loom/mark` is a `LoomMarkRecord` holding a `LoomMark`, `keep` or `set-aside`, or null to clear it; the `loomMark` projection publishes the last one as a `LoomMarkView`, or null. Only records at or after the Session's inherited event count count, so a fork of a branch or of a marked Session starts with neither. Marks are never feedback events, and telemetry export removes the payload of every `plugin:loom/*` record.

## What the model saw

`LoomRequestAtRequest` names a Session and any event seq. `LoomRequestView` describes the latest model request whose `assistant/message` or `assistant/attempt` settlement is at or before that seq, rebuilt from the whole log the way the agent loop derives it: a `LoomRequestRoute` and the tool names from the `request/header` in force, a `LoomRequestTools` with the tool additions and removals that `developer/message` events logged in the request's turn, a `LoomRequestSystemPrompt` with the effective system prompt and the turn that wrote it when it changed after the first prompt, and one `LoomRequestMessage` per request message with its producing seq, role, inherited flag, bounded preview, and length. `inheritedTurns` and `ownTurns` split the turns started before the request at the fork cut. The view is the request the loop built before the provider route projects it, so a route without tool-update support does not receive the developer rows. A seq outside the log or before the first settlement fails with `loom/seq-out-of-range`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxloom--loom"></a>

### `ctx.loom` — `Loom`

Loom Host service. It registers the `loomBranch` and `loomMark` projection units, the telemetry redaction rule for `plugin:loom/*` records, and the branch runner for its own lifetime, and exposes the `loom` Remote namespace.

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

Source: [`packages/experimental/loom/src/index.ts`](../../packages/experimental/loom/src/index.ts)
<!-- END GENERATED cordis-surface -->
