---
description: "Use the experimental Loom Host service: branch sets, worktree isolation, outcome compare, adopt and apply, private marks, fork families, and the loom Remote."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-loom

English | [中文](README.zh.md)

## Summary

Loom lets you branch a Session into alternatives, optionally isolate each in a Git worktree, follow sets, withdraw queued children, and compare outcomes and diffs. You can privately mark or adopt branches, archive siblings, apply or discard isolated changes, navigate fork families, inspect model requests, and continue from edited tool results. Weave generates and curates prose continuations, explores token alternatives, and exports paths with their choices. Enable these experimental features through [`@deepseek-ai/dsh-experimental-loom-bundle`](../loom-bundle/README.md).

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

For the Web workflow and prerequisites, start with the [Loom guide](../../../docs/user/guide/loom.md). Use the [Loom bundle](../loom-bundle/README.md) to compose the matching Host, browser, worktree, and tool packages.

Compose the row with the Session Controller, the Session store, the Session projection registry, Remote access, Typert, the filesystem, and the Workspace registry; the Web profile supplies all seven. Worktree isolation also needs [`@deepseek-ai/dsh-experimental-worktree`](../worktree/README.md) with the sandbox, subprocess, and working-directory services it injects, and diffs of children that share a folder need [`@deepseek-ai/dsh-workspace-changes`](../../deliverables/workspace-changes/README.md); `compare()` reads own usage from the `tokenUsage` and `sessionStats` projections. The browser half, [`@deepseek-ai/dsh-experimental-client-ui-loom`](../client-ui-loom/README.md), mounts this package's generated `/remote` contribution. Request and result types come from `@deepseek-ai/dsh-experimental-loom/types`.

| Field | Default | Meaning |
|---|---|---|
| `maxBranchesPerRequest` | `8` | Largest number of children one `branch()` call may create; a larger request fails before any fork. |
| `maxConcurrentBranches` | `4` | Largest number of Loom children, across every set, that are being forked or are running their first prompt at once. |
| `retainedBranchSets` | `256` | Finished sets retained in Host memory. Oldest finished sets and their retry results are evicted first; active sets stay. |
| `pricing` | `[]` | Provider/model list-price rows with `inputMissPerMTok`, `inputHitPerMTok`, and `outputPerMTok` in USD per million tokens. Empty route ids, duplicate routes, negative or nonfinite prices fail the plugin load. |
| `concurrentWritableBranches` | `false` | When false, children whose inherited sandbox mode can write their folder run one at a time per folder; read-only children and worktree children are not limited by it. |
| `defaultIsolation` | `shared` | Where children keep their files when a `branch()` request names no `isolation`: `shared` or `worktree`. |
| `worktreeBranchPrefix` | `loom/` | Prefix of each isolated child's Git branch and worktree directory, followed by the child's Session id; one that cannot start a relative branch name fails the plugin load. |
| `outcomes.commandTools` | `bash`, argument `command` | Tools whose results `compare()` reads as command output, each with the string argument that names the command. |
| `outcomes.testSummary` | unittest, pytest, Vitest, Jest | Test summary patterns, described under [Compare siblings](#compare-siblings); a pattern that cannot work fails the plugin load. |
| `diff.maxBytes` | `262144` | Largest `diff()` text in UTF-8 bytes. |
| `apply.maxPatchBytes` | `33554432` | Largest change `apply()` copies, in UTF-8 bytes of its binary patch. |
| `weave` | [Schema defaults](src/weave.ts) | Sibling, output, prefix, timeout, framing, and cache-warming limits for auxiliary prose calls. |
| `probe` | [Schema defaults](src/weave.ts) | Depth, cumulative probability, request, and alternative limits for token exploration. |
| `export` | [Schema defaults](src/export.ts) | Maximum encoded bytes, retained downloads, and download lifetime. |

### Branch a Session

`branch(request)` creates one branch set from the Session `sessionId` and returns its `setId` with one entry per child in request order. Every child is a top-level fork Session; the source is never written. The four kinds choose the cut and each child's prompt:

| `kind` | Fields | Children | Cut | Prompt |
|---|---|---|---|---|
| `regenerate` | `turn`, `count` | `count` | before the prompt that opened `turn` | that prompt, unchanged |
| `edit` | `turn`, `text` | 1 | before the prompt that opened `turn` | that prompt with its text parts replaced by `text`; image and file parts keep their stored references |
| `steer` | `afterTurn`, `lines` | one per line | at the end of `afterTurn` | the line, verbatim |
| `variants` | `afterTurn`, `lines`, `samples` | `lines.length × samples`, line by line | at the end of `afterTurn` | the line, verbatim; every sample of one line shares a `variantKey` |

The cut before turn k keeps every completed turn before it and the standalone events that followed the last one, such as a model selection, and stops before turn k's prompt. For turn 1 it is the standalone events before the first prompt. The cut at the end of a turn is its `turn/end` and the standalone events after it, stopping before the next turn or queued input. A prompt the source had queued while an earlier turn ran is pending at the cut; the runner removes it from the child before sending the child's own prompt, so it never runs there.

A `regenerate` or `edit` of the first turn a fork Session started itself branches beside the fork instead of below it: the children are forked from the fork's parent at the fork's cut, receive the fork's own opening prompt, unchanged or edited, and record the parent as their source, so they join the fork's variants. Without `selection`, they take the route its first request used when that differs from the route at the cut, otherwise the last route the fork selected before that turn. The caller must also be allowed `loom/branch` on the parent. When the parent no longer exists, the children are cut in the addressed fork instead, below it, and resend the fork's own opening prompt. Any other turn, including every turn of a subagent child or of a Session that is not a fork, is cut in the addressed Session.

Each child prompt carries a `user` source whose `rpcId` is the request's `requestId` followed by `/` and the child index, the browser time zone of the source prompt it stands in for (for `steer` and `variants`, of the latest source prompt at or before the cut that recorded one), and the caller when it is not the owner. `selection` names a route for every child's next request; the Session Controller's fork validates it for each child when the child is admitted and records it in the child only, so a route that is unavailable then fails each child with `session/model-unavailable`, not the request. Without it, a child continues on the route the fork gives it.

A child entry is `started` with its `sessionId` once its Session exists, holds its branch record, and was sent its prompt; `queued` while it waits for a concurrency slot and has no Session; `failed` with a RemoteError `code`, a `message`, and the `sessionId` when the Session was created before the failure, for example when the fork could not attach it to the source's Workspace or rejected `selection`; or `cancelled` when the Loom service unloaded while the call waited for the set's first admissions and withdrew the child before it had a Session. One failed child leaves the others running. While the set is retained, a retry with the same `requestId` for the same Session returns the first result and creates nothing; a request that failed validation created nothing, so its retry is validated again.

These failures happen before any fork:

| Code | Cause |
|---|---|
| `session/not-found` | The addressed Session does not exist. |
| `remote-access/denied` | The caller may not branch the existing fork parent that a first-own-turn `regenerate` or `edit` branches from; `details.action` is `loom/branch`. |
| `gateway/bad-request` | `count`, `samples`, or the number of `lines` is not a positive integer. |
| `loom/too-many-branches` | The request asks for more than `maxBranchesPerRequest` children; `details` carry `requested` and `limit`. |
| `loom/empty-line` | A line, or the edit text, has no non-whitespace character; `details.index` names it. |
| `loom/turn-unavailable` | `details.reason` is `not-found` (no such turn), `not-ended` (a `steer` or `variants` turn has no `turn/end`), `not-user-opened` (a `regenerate` or `edit` turn did not open with a user prompt), or `no-cut` (the log's first event admits that prompt, so no prefix keeps the history before it). |
| `loom/isolation-unavailable` | An `isolation: 'worktree'` request cannot get worktrees; `details.reason` is described under [Isolate children in worktrees](#isolate-children-in-worktrees). |
| `gateway/cancelled` | The Loom service unloaded while the call read the addressed Session or the fork parent, before the set existed. |

### Follow and cancel a branch set

`setStatus({ setId })` returns the set's `sourceSessionId` and every child with its state: `started`, `queued`, `failed`, or `cancelled`, the `sessionId` of a child whose Session exists, and the `code` and `message` of a failure. A child that is being forked reads `queued`. `cancel({ setId, indices? })` withdraws queued children, every queued child when `indices` is omitted, and returns the withdrawn indices; a child that is being forked or has started is left alone. Both read Host memory: a set created before the Host restarted, or one whose `branch()` call addressed a Session the caller cannot reach, fails with `loom/set-not-found`. After eviction, `setStatus()` and `cancel()` also report `loom/set-not-found`, and reusing its `requestId` creates a new set. Started children stay findable through the fork family and their `loomBranch` values.

### Preview list-price cost

`estimate({ sessionId, kind, turn?, afterTurn?, count, selection? })` reads the same turn and count rules as branching without creating a Session or calling a model. Regenerate and edit use the named turn's recorded usage (`basis: 'own-turn'`); steer, variants, and turns without usage use the visible fork family's average own turn (`basis: 'family'`). The family root contributes its whole usage; forks contribute only their own usage, so inherited prefixes are counted once. `selection` changes the route priced without changing the token basis.

With a configured price, `priced` is true and `perBranch` and `total` are USD ranges: `low` assumes all input hits the cache, `high` assumes all input misses, and both charge the recorded output; reversed configured prices still produce ordered bounds. With no price, the ranges are total input-plus-output tokens and `priced` is false. Without recorded token evidence, both ranges are absent. `cacheShare` is the observed cached-input share, or zero without input. These are list-price estimates, not measured charges. Cache writes cost the input miss price; output includes reasoning tokens. No prices ship by default.

`estimate({ sessionId, kind: 'weave', count, maxTokens?, prefix?, selection? })` uses the latest own Weave request with reported sibling usage on the selected provider/model, preferring an exact joined prefix match. It averages those siblings' recorded input and prices the full requested output cap in both cache-price endpoints; it never guesses tokens from text. `basis: 'weave-history'`, `historicalInput` and `outputCap` distinguish this historical input from measured usage of a new cursor. No own usage on that route means no ranges; no configured price means token figures. Probes and inherited requests supply no basis. Prose count and output limits use `weave.maxSiblings` and `weave.maxTokens`; previews create no Agent or provider call.

### Mark a Session

`mark({ sessionId, mark })` sets `keep` or `set-aside` on any Session the caller can reach, or clears it with `null`, and returns the mark in force. The Session's Agent is resumed when the Session is cold. The mark is a `plugin:loom/mark` record in that Session, flushed before the call returns; a request for the mark the Session already holds writes nothing. Marks never write feedback events. A Session that does not exist fails with `session/not-found`.

<a id="isolate-children-in-worktrees"></a>
### Isolate children in worktrees

`isolation: 'worktree'` on a `branch()` request, or `defaultIsolation: 'worktree'`, gives each child a Git worktree of its own instead of the source's folder. Before any fork, such a request fails with `loom/isolation-unavailable` and a `reason`: `service-unavailable` without the worktree service, `read-only` when the sandbox mode at the cut cannot write, `no-repository` when no Git repository contains the source's working directory at the cut, and, under a confined mode, `subdirectory` when the repository root lies above the source folder or `linked-checkout` when the folder's `.git` entry is a file, because Git would then write outside the folder the sandbox allows. Under `danger-full-access` the last two are allowed.

Each admitted child gets the branch `<worktreeBranchPrefix><child Session id>` and a worktree in the worktree service's pool of the source repository, and enters it through the working-directory service before its prompt. All children of a set start from one base commit, recorded when the set's first child is admitted: the source folder's HEAD, or a new commit above HEAD that holds the folder's staged and unstaged changes to tracked files. Untracked and ignored files are not carried, and nothing is installed in the new checkout. The child records `plugin:loom/isolation` with the base commit, the worktree path, the branch, and the repository root before its prompt. Worktree children are exempt from the one-writer-per-folder rule and run at once, up to `maxConcurrentBranches`; Loom creates, applies, and removes the worktrees of one repository one at a time. A child whose worktree cannot be created fails with its Session and without records or prompt.

<a id="compare-siblings"></a>
### Compare siblings

`compare({ sessionId, setId? })` returns the `parent`, the `cutSeq` and, when a turn ended at or before it, the `cutTurn` of a cut, and one row per sibling the caller may reach. Without `setId`, the siblings are the forks of the parent at the cut of `sessionId`, which must itself be a fork; with it, they are the members of that set, addressed through its source, any member, or a fork beside the set whose first own turn the set regenerated or edited. Rows are ordered by creation time, then by set and request index, then by Session id. Each row reads the sibling's own log after its cut:

| Field | Source |
|---|---|
| `title` | The latest Session title, or empty. |
| `prompt` | The text of the first own prompt from a user or from Loom, or empty. |
| `kind`, `isolation` | The own branch record, or `fork` for a fork outside any set; `worktree` when the sibling holds an isolation record. |
| `worktreeEnded` | Whether Loom applied or discarded an isolated worktree; absent for shared folders. A missing diff alone does not mean the worktree ended. |
| `running` | The Session list row. |
| `tests` | The last test summary in own command output, described below. |
| `diff` | Git in the worktree against the base commit, untracked files included; for a shared folder, the change summaries of the sibling's own turns summed per file. Absent when they cannot be read. |
| `own` | Own steps and tokens from the fork split of the `sessionStats` and `tokenUsage` projections; `inputTokens` counts uncached input and cache writes, `cachedTokens` counts cache reads. `usd` holds `{ amount, label: 'list price' }` when every own request has usage and a configured price; each request uses its logged route. |
| `wallMs` | The summed duration of own ended turns. |
| `mark`, `adopted` | The own mark and adopt records. |

Test outcomes come from the model-facing text of own results of `outcomes.commandTools` calls, never from tool metadata. Every `outcomes.testSummary` pattern is matched against each result with terminal control sequences removed, with `^` and `$` at line boundaries; the match that ends last in the latest result that has one wins. Its `passed`, `failed`, `errors`, `skipped`, and `total` patterns are searched in the matched text, each count from its first capture group: errors count as failed, a missing total adds the other counts, and a missing passed count is the total less failed and skipped. `ok` is true when nothing failed and the total is positive, and `command` is the call's command argument. A worktree row's diff resumes the sibling's Session when it is cold; a diff that cannot be read is logged and left out. `compare()` fails with `loom/not-a-fork`, with `loom/set-not-found` for a set without a reachable member, or with `gateway/internal` when a sibling's usage projections are not composed.

<a id="read-a-branch-diff"></a>
### Read a branch diff

`diff({ sessionId, path? })` returns Git-style unified text, file after file in path order, for one branch or for the one changed file that `path` names, and sets `truncated` when files were left out to stay within `diff.maxBytes`. A worktree child's text comes from Git against its base commit, with untracked files shown as new files; a shared child's text renders the change summaries of its own turns, one section per turn that changed a file. It fails with `loom/worktree-unavailable` for a worktree that Loom removed (`removed`) or that its repository no longer registers (`missing`), and with `loom/diff-unavailable` when this Host does not hold a shared child's change summaries.

<a id="adopt-apply-and-discard"></a>
### Adopt, apply, and discard

`adopt({ sessionId })` makes one fork the line to continue. It writes `plugin:loom/adopt` once into that fork, then archives its siblings through the Workspace registry, stopping their running work first: the other members of its set, or, for a fork outside any set, every other fork at its cut. Archived Sessions keep their logs and can be restored; nothing is deleted. The caller needs `loom/adopt` on every sibling, checked before any write (`remote-access/denied`). It returns the fork and every archived sibling; when an archive fails, it fails with `loom/adopt-incomplete` naming the archived and remaining siblings, and a retry finishes the rest. The `loomBranch` value of an adopted branch child gains `adopted: true`.

`apply({ sessionId })` copies an idle worktree child's whole change, untracked files included, into the source folder with `git apply`, then removes the worktree and its branch, and returns the written paths. The change lands in the working tree only, unstaged, and new files stay untracked; files the change does not name keep their bytes. Before any write it fails with `loom/apply-dirty` and the paths when the source folder has staged or unstaged changes to tracked files, so a set branched from uncommitted work applies only after that work is committed; with `loom/apply-conflict` and the paths when the change does not apply; and with `loom/apply-too-large` beyond `apply.maxPatchBytes`. A child that shares the folder fails with `loom/apply-not-isolated`. When the change was written but the worktree could not be removed, it fails with `loom/worktree-cleanup-failed`, which names the written paths, and `discard()` removes the worktree later. `discard({ sessionId })` removes an idle child's worktree and branch with their files and returns the path and branch. Only successful removal writes `plugin:loom/isolation-end` and moves the child back to the repository root when it was inside the worktree; both operations touch only the worktree that the child's isolation record names. Renaming or switching the checkout's Git branch prevents owned-worktree removal: restore its recorded branch, then retry `discard()`. After `loom/worktree-cleanup-failed`, inspect the already-applied source changes and retry cleanup with `discard()`, not `apply()`. A running child fails with `session/agent-busy`; a child without a worktree fails with `loom/worktree-unavailable` (`shared`, `removed`, or `missing`).

Both `apply()` and `discard()` reserve the child's `runMaintenance()` slot until removal and its isolation-end record settle. Prompts that arrive meanwhile wait for the slot to finish; another maintenance operation receives `session/agent-busy`.

### Read a fork family

`family({ sessionId })` reads the current Session list without activating an Agent and returns the fork family of `sessionId`: the highest listed fork ancestor as `rootId`, the requested Session as `focusId`, and every listed fork descendant of the root in `nodes`. Nodes are in depth-first order, with siblings ordered by creation time and then by Session id; the creation time comes from the row's `forkLineage` list hint, and a sibling without that hint follows every sibling with one. Each node carries its depth, its parent node, its creation time when known, and the `updatedAt`, `running`, and `blank` list facts. A subagent's parent link is not a fork link, so subagent children are not family members. Only Sessions the caller may list appear. An unlisted `sessionId` fails with `session/not-found`.

The `@deepseek-ai/dsh-experimental-loom/family` export holds the same derivation without Host dependencies: `forkFamily(rows, sessionId, previous?)` takes `LoomFamilyRow` values mapped from any Session list and, given an earlier result, keeps each unchanged node reference. The browser plugin derives families from its client Session list with it and does not call `family()`.

### Read what the model saw

`requestAt({ sessionId, seq })` rebuilds one model request from the Session's whole log without activating its Agent. `seq` may name any event; the result describes the latest request whose `assistant/message` or `assistant/attempt` settlement is at or before it, so each attempt of a retried step addresses its own request. The `LoomRequestView` holds the `route` (provider, model, and reasoning effort) and tool `names` of the `request/header` in force, the tools that `developer/message` additions and removals changed in the request's turn before it, the effective `systemPrompt` text with the turn that wrote it when that was not the Session's first prompt, and every request message in model-visible order. Each message row carries its producing seq, its role (a developer message reports `system`), whether the Session inherited it from its fork source, a whitespace-collapsed preview of at most `LOOM_REQUEST_PREVIEW_MAX_CODE_POINTS` code points, and its length in code points. `inheritedTurns` and `ownTurns` count the turns started before the request on each side of the fork cut.

A seq outside the log, or before the first settlement, fails with `loom/seq-out-of-range`, whose `range` names the seqs that address a request, or is null when no request has settled. An unknown Session fails with `session/not-found`; a caller without access to the Session receives the Gateway's `remote-access/denied`.

### Replace a tool result and continue

`counterfactual({ sessionId, resultSeq, content })` forks a completed tool step, replaces only the named result's visible text, and continues the child without adding a user message. The cut retains all companion results from the same step, so every retained tool call remains answered. The child records `plugin:loom/tool-result-override` and a content-only surface replacement; the source Session is unchanged. An incomplete tool batch is refused before a fork with `loom/counterfactual-unavailable`. A failure after creating the child reports `loom/counterfactual-incomplete` with that child's id so the retained work can be inspected.

### Generate prose at a cursor

`weave({ sessionId, parent, prefix, n, controls?, route? })` creates `n` auxiliary continuations, with no Chat messages or tools. `prefix` is an ordered list of spans authored by the user, copied from a recorded model node, or selected from that node's captured token alternatives. Model spans must occur in their cited node; alternative spans must match the cited token position. The joined prefix is the exact assistant prefix, and `parent` identifies the prose node being extended. The chosen route must support tool-free assistant prefixes and the requested log probabilities. Every exact request is logged as `plugin:loom/weave-request` before dispatch; every settled sibling, including failures and cancellations, is retained as `plugin:loom/weave-node`.

Cold prefixes use lead-then-burst scheduling: the first sibling starts alone, then the rest start after its first token or settlement and `weave.leadDelayMs`. A repeated prefix within `weave.warmWindowMs` starts all siblings together. `weaveState({ sessionId })` reconstructs nodes, their exact prefix spans, current choices, model tokens, and curation bits after reload. `choose({ sessionId, nodeId })` records one completed Weave choice per sibling set. Changing that choice replaces its credit; choosing it again writes nothing. Curation is the sum of `log2(n)` over those sets' completed alternatives. Probe nodes and Session marks add no credit.

`probe({ sessionId, parent, prefix, route?, depth?, cutoff? })` explores next-token alternatives breadth first. The configured depth and request limits bound calls, and cumulative probability prunes each path. Every probe uses the same logged auxiliary request and node records as Weave; returned alternatives cite their recorded node and token position so a continuation can preserve their attribution. Probabilities are exposed only where the recorded token sequence covers the exact output text.

Prose refusals include a `reasonCode` for route capabilities, limits, prefix attribution, route selection, active work, provider failure, or cancellation. Unsupported prefixes and token probabilities are refused before any request record or model call. Failed nodes retain a provider-neutral `failureCode` alongside diagnostic text. Probe results list sampled positions separately from surviving alternatives, so a client can distinguish unexplored paths from sampled positions whose probability mass was omitted.

### Export a path or selection

`export({ sessionId, mode, nodeId?, format? })` returns an owner-authenticated download URL for a bounded, immutable snapshot. `mode` is `path`, `siblings`, or `kept`; `format` is `json` by default, `text`, or `html`. With `nodeId`, the snapshot contains the selected prose path, its siblings, or the current chosen prose nodes, including spans and curation records. Otherwise it contains Session history, same-cut sibling history, or kept Sessions in the visible fork family. Text and HTML retain the full JSON record after the readable text. URLs expire after `export.ttlMs`; the oldest downloads are evicted at `export.maxDownloads`, and snapshots larger than `export.maxBytes` are refused before a URL is created. Without the connection service, or for a non-owner caller, the operation reports `loom/export-unavailable`.

### Branch membership and marks

`plugin:loom/branch` is an ignorable plugin record that a branch child holds before its first prompt: the set, the source Session and the seq it was cut at, the kind, the child's index, and the `variantKey` of a `variants` child. The `loomBranch` projection publishes `{ setId, kind, index, variantKey?, createdAt }` from the first valid own record, with the record's time as `createdAt`, and `null` for a Session that is not a Loom branch child. `plugin:loom/mark` records `{ version, mark }`; the `loomMark` projection publishes the last own mark as `{ mark }`, or `null`. `plugin:loom/isolation` records `{ version, baseCommit, worktreePath, branchName, repositoryRoot }`, `plugin:loom/isolation-end` records `{ version, reason }` with `applied` or `discarded`, and `plugin:loom/adopt` records `{ version, setId? }`; after a valid own adopt record, the `loomBranch` value adds `adopted: true`. Both units ignore records before the Session's inherited event count, which a fork of a branch or of a marked Session inherits, and records whose payload fails validation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`Loom` extends `TypertRemoteService` with service key and namespace `loom`. Its constructor registers the `loomBranch` and `loomMark` units, a `session-telemetry/record` listener, and the branch runner's teardown on its own fiber, so unloading the plugin removes all of them. The Gateway authorizes `branch()`, `mark()`, `family()`, and `requestAt()` against the addressed Session through the `sessionId` field the Session Controller registers as the `session` resource. `setStatus()` and `cancel()` name no Session, so the Gateway checks them against the `global` resource; the method then also requires `ctx.remoteAccess.allows()` on the Session the set's `branch()` call addressed, for the call's own action, so a non-owner needs both grants. `family()` filters list rows the same way.

`branch()` reads the addressed Session with `ctx.sessionController.inspect()` and resolves the request in one step, `resolveBranch()`, which returns the cut, every child's content, the next-turn prompts pending at the cut (`inheritedNextTurnPrompts()`), the browser time zone, whether the children can write, and their folder. The cut uses the Session Controller's `completedPrefixBefore()` and, for the end of the source's last completed turn, `latestCompletedPrefixBoundary()`. The prompt that opened turn k is the head of the next-turn queue at `turn/start(k)` when it entered that turn as a `user/message` from a `user` source. When a `regenerate` or `edit` names the first `turn/start` at or after a fork's inherited event count, and the fork is not a subagent child, the source is the header's `parentSession` and the cut is the inherited event count minus one; the fork's log through that cut is the parent's, so the queued prompts and sandbox mode are read from it. Without a request `selection`, the children take the fork first request's logged route when it differs from the route at the cut, otherwise the last `model/selection` between the inherited events and that `turn/start`. Before any fork, the runner requires `ctx.remoteAccess.allows()` on the parent for the call's `loom/branch` action, because the Gateway authorized only the fork, and then inspects the parent, so that a caller without that grant fails with `remote-access/denied`. A parent that `inspect()` reports as `session/not-found` makes the runner resolve the request again with `redirect` false, which cuts in the addressed fork as for any other turn; any other read failure propagates. A child is writable unless the last `sandbox/mode` event through the cut, or else the composed `sandboxPolicy` default, is `read-only`; without a sandbox policy every child counts as writable. Its folder is the addressed Session's header `cwd`, which a fork copies from its parent.

The runner keeps sets in Host memory for the plugin lifetime. Admission scans the queue in order and admits each child whose slot rules allow it, so children of one set start in index order and sets start in request order; a writable child blocked by its folder does not hold back a read-only child behind it. One admission calls `ctx.sessionController.fork({ sessionId, atSeq, selection? })`, resolves the child's Agent, removes each inherited next-turn prompt with `agent.inbox.remove()`, appends the branch record with `appendPluginRecord()`, sends the prompt with `agent.followup()`, and awaits `ctx.sessions.flush()`. The slot is held from admission until the child's Agent reaches whole-agent idle after the prompt (`agent.whenIdle()`), or released at once when a step before the prompt fails. Teardown withdraws queued children and awaits every admission in flight, so no fork is left without its record and prompt. A `branch()` call waiting on its set's admissions then returns the set with the withdrawn children `cancelled`, because the admitted children run on and the caller follows them by the set id; a call that teardown overtakes before its set exists fails with `gateway/cancelled`. Tests cover each Host contract with the real agent loop and the plugin-mounted Session Controller; `branch.e2e.ts` runs regenerate and steer sets on the OpenRouter DeepSeek route.

Isolation resolves in `resolveIsolation()` after `resolveBranch()`, which applies `defaultIsolation`: it reads the source folder and the working directory at the cut, asks `ctx.worktrees.locate()` for the repository, and compares the repository root with the folder through `ctx.fs`. Admission creates each worktree with `ctx.worktrees.create()`, with `includeUncommitted` for the set's first child and `from` that child's base commit for the rest, in the repository's turn of a queue that `apply()` and `discard()` share. `compare()`, `diff()`, `apply()`, and `discard()` run every Git command through `ctx.worktrees.git()` or `ctx.worktrees.remove()`, which disable hooks and the file-system monitor and confine the command to the child's own Session policy; `git apply` also runs with configured filters disabled. Reads add `--no-optional-locks`, `--literal-pathspecs`, `--no-ext-diff`, and `--no-textconv`, and list untracked files with `git ls-files --others --exclude-standard` and one `git diff --no-index` each. `apply()` builds one `--binary` patch from those diffs, checks `git status --porcelain --untracked-files=no` and `git apply --check` in the source checkout, and applies it with `git apply`; unloading does not cancel that write. Rows read each sibling with `ctx.sessionController.inspect()` and `projections()`, and the siblings from `list()` filtered through `ctx.remoteAccess.allows()`. The operations hold a lifetime abort signal and a pending set that the plugin's teardown aborts and awaits. Host specs exercise them on temporary Git repositories, and `isolation.e2e.ts` runs two worktree children, a compare, an apply, and a discard on the OpenRouter DeepSeek route.

`branchFor(request, { source, prepare? })` is a Host-only entry with the same branch validation, admission, and retry identity. It authorizes nothing: its caller owns Session access. `prepare` runs after each child's branch record and before its prompt; throwing fails that child without sending the prompt. Autoloom uses it to set non-interactive permissions and a `loom` message source. `ownUsd(session)` is a Host-only synchronous budget read, incrementally folding newly appended events and pricing each own settlement against its logged route. It returns undefined when any own request lacks usage or a price, and returns zero before any own settlement only when a priced route is logged. Neither entry activates another Agent.

The redaction listener calls `next()` and replaces the `body` of every `plugin:loom/*` ledger record with `null`, keeping `sourceEvent`. `requestAt()` reads `ctx.sessionController.inspect()`, the attached log or a cold read, and derives the request as the agent loop does: `foldSurface()` over the events before the settlement with `ctx.sessions.messageProjections`, `deriveEventMessage()` per surface node, and `foldRequestHeader()` for the header. The result equals the request the loop passes to `llm/stream` listeners; the host spec compares the two across a fork of a fork, a compaction-style surface replacement, and a retried step, and the Loader composition spec compares them in the shipped Web profile with the Loom bundle patch.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Loom interface Agent Note](../../../.agents/notes/implemented/feature/2026-10-18-loom-interface.md)

-----

<a id="model-experience"></a>
## Model Experience

### Branch child prompt

#### What the model sees

Each branch child's first own request ends with one `user` message that the runner sent, preceded for a worktree child by the working-directory notice that entering its worktree queues: for `regenerate`, the content of the prompt that opened the named turn in the addressed Session, byte for byte; for `edit`, that content with its text parts replaced by one text part holding the request's `text`; for `steer` and `variants`, the request line as a single text part. The earlier messages are the source's request messages through the cut, rebuilt by the agent loop from the inherited log. A prompt the source had queued at the cut is removed and never reaches the child's requests. The branch and mark records are not model-visible.

#### Token effect

A child's first request costs the inherited prefix plus the new prompt; a request with N children sends N such requests, at most `maxConcurrentBranches` at once. Marks, status reads, and cancellation add no tokens.

#### KV Cache effect

A child's first request repeats the source's request prefix through the cut and appends the new prompt, so the provider can reuse the cached prefix when the request reaches the same cache. The Session Controller's fork gives every member of a fork family the family root's cache key. A `selection` whose route differs from the inherited route adds the agent loop's model-switch notice and is a different cache. A worktree child's directory notice follows the inherited prefix, so the cached prefix is unchanged. Compare, diff, adopt, apply, and discard add no model input; a change that `apply()` writes reaches a later request only through tools that read the folder.

### Auxiliary prose requests

#### What the model sees

Weave and probes send the configured system and user framing plus the exact assistant prefix. They send no Session conversation or tool declarations, use reasoning off on reasoning-capable routes, and record their effective route, controls, framing, prefix spans, and streams in experimental Loom records. Counterfactual continuation uses the ordinary loop request with the substituted tool-result text and all companion results.

#### Token effect

Each sibling sends the full framed prefix and produces up to the resolved output limit. Probes request one output token per explored prefix and stop at the request budget. Choosing and exporting add no model calls. The curation meter counts choices among completed Weave siblings, independently of billed tokens.

#### KV Cache effect

Siblings repeat the exact request prefix; lead-then-burst gives the lead call time to populate the provider cache before the remaining siblings start. The warm-prefix cache is a Host scheduling hint, not a guarantee of a provider cache hit. Editing a prefix changes the reusable suffix; changing the route or framing uses a different scheduling key.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Branch sets live in Host memory only. A Host restart drops every set: its queued children never start, and `setStatus()` and `cancel()` report `loom/set-not-found`. Started children keep their Sessions and records.
- Active sets stay in memory; at most `retainedBranchSets` finished sets and their `requestId` results remain. A set finishes after every admitted child reaches whole-agent idle or fails and every queued child is withdrawn; eviction removes no Session or worktree.
- With `concurrentWritableBranches` false, the runner serializes only the first prompt of Loom children that share a folder. The source Session, other Sessions, and later prompts in a child still write the same folder concurrently, and the change summaries of concurrent shared children can attribute each other's edits; worktree isolation removes the overlap for the children that use it.
- A worktree set's base is recorded when its first child is admitted, which is after the `branch()` call when every slot is busy. Untracked and ignored files are not carried, dependencies are not installed, and a repository without a commit fails each child.
- Worktrees stay until `apply()` or `discard()`; adopting or archiving a branch keeps its worktree.
- `apply()` copies a patch, never a fast-forward or merge, and refuses any tracked change in the source folder, including the uncommitted work that the set's base carried.
- `compare()` resumes cold worktree siblings to read their diffs, runs one Git process per untracked file, and reads a shared child's diff only while this Host holds its change summaries, which `workspace-changes` keeps for live Sessions. Test outcomes are pattern matches on command output; a runner whose summary no pattern matches reports none.
- A child's slot lasts until its Agent reaches whole-agent idle, so prompts a user sends to a running child extend it.
- A child's prompt is a new message with a new id, not the source message. A `regenerate` re-sends stored image and file references without a new upload receipt; a file reference that the Agent must bind again was not verified.
- `mark()` resumes a cold Session's Agent to append the record.
- Loom records are experimental plugin records. A Session format migration keeps them only on a best-effort basis; a dropped `plugin:loom/branch` record makes `loomBranch` report the Session as an ordinary fork, and a dropped `plugin:loom/mark` record clears its mark.
- `family()` reads the whole Session list on each call and stops at a parent that is hidden, deleted, or outside the caller's access, so such a family is rooted at its highest visible ancestor.
- Exported telemetry still carries each Loom record's envelope, including its type and seq; only the payload is removed.
- `requestAt()` describes the request the agent loop built, before the provider route projects it: a route without tool-update support receives the messages without developer rows and learns tool changes only from the tool list, and file and offloaded image blocks reach every route as handle text.
- `requestAt()` reads and folds the whole log on every call and returns every message and the complete system prompt text, without paging.
- Auxiliary prose requires an explicitly supported prefix route. It does not continue Chat histories containing tools; generated prose remains in its own recorded node tree.
- Prose operations hold the Session's maintenance slot, and unloading aborts and awaits their calls. The Host warm-prefix hints and download URLs are lost on restart; the recorded prose tree and choices remain.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
