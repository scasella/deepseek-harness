---
description: "Use the experimental Loom Host service: branch sets, private marks, fork families, and the loom Remote."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-loom

English | [中文](README.zh.md)

## Summary

The `ctx.loom` service holds the Host half of Loom, which treats forked Sessions as a tree. Its `loom` Remote namespace branches a Session into sets of fork children, reports and cancels the children of a set, sets private keep and set-aside marks, reads fork families, and rebuilds what the model received at any event of a Session. It declares the `plugin:loom/branch` and `plugin:loom/mark` records, publishes each Session's own membership and mark as the `loomBranch` and `loomMark` projections, and removes Loom record payloads from exported telemetry. Enable it through [`@deepseek-ai/dsh-experimental-loom-bundle`](../loom-bundle/README.md).

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

Compose the row with the Session Controller, the Session store, the Session projection registry, Remote access, and Typert; the Web profile supplies all five. The browser half, [`@deepseek-ai/dsh-experimental-client-ui-loom`](../client-ui-loom/README.md), mounts this package's generated `/remote` contribution. Request and result types come from `@deepseek-ai/dsh-experimental-loom/types`.

| Field | Default | Meaning |
|---|---|---|
| `maxBranchesPerRequest` | `8` | Largest number of children one `branch()` call may create; a larger request fails before any fork. |
| `maxConcurrentBranches` | `4` | Largest number of Loom children, across every set, that are being forked or are running their first prompt at once. |
| `concurrentWritableBranches` | `false` | When false, children whose inherited sandbox mode can write their folder run one at a time per folder; read-only children are not limited by it. |

### Branch a Session

`branch(request)` creates one branch set from the Session `sessionId` and returns its `setId` with one entry per child in request order. Every child is a top-level fork Session; the source is never written. The four kinds choose the cut and each child's prompt:

| `kind` | Fields | Children | Cut | Prompt |
|---|---|---|---|---|
| `regenerate` | `turn`, `count` | `count` | before the prompt that opened `turn` | that prompt, unchanged |
| `edit` | `turn`, `text` | 1 | before the prompt that opened `turn` | that prompt with its text parts replaced by `text`; image and file parts keep their stored references |
| `steer` | `afterTurn`, `lines` | one per line | at the end of `afterTurn` | the line, verbatim |
| `variants` | `afterTurn`, `lines`, `samples` | `lines.length × samples`, line by line | at the end of `afterTurn` | the line, verbatim; every sample of one line shares a `variantKey` |

The cut before turn k keeps every completed turn before it and the standalone events that followed the last one, such as a model selection, and stops before turn k's prompt. For turn 1 it is the standalone events before the first prompt. The cut at the end of a turn is its `turn/end` and the standalone events after it, stopping before the next turn or queued input. A prompt the source had queued while an earlier turn ran is pending at the cut; the runner removes it from the child before sending the child's own prompt, so it never runs there.

A `regenerate` or `edit` of the first turn a fork Session started itself branches beside the fork instead of below it: the children are forked from the fork's parent at the fork's cut, receive the fork's own opening prompt, unchanged or edited, and record the parent as their source, so they join the fork's variants. Without `selection`, they take the last route the fork selected before that turn, so they run on the fork's route. The caller must also be allowed `loom/branch` on the parent. When the parent no longer exists, the children are cut in the addressed fork instead, below it, and resend the fork's own opening prompt. Any other turn, including every turn of a subagent child or of a Session that is not a fork, is cut in the addressed Session.

Each child prompt carries a `user` source whose `rpcId` is the request's `requestId` followed by `/` and the child index, the browser time zone of the source prompt it stands in for (for `steer` and `variants`, of the latest source prompt at or before the cut that recorded one), and the caller when it is not the owner. `selection` names a route for every child's next request; the Session Controller's fork validates it for each child when the child is admitted and records it in the child only, so a route that is unavailable then fails each child with `session/model-unavailable`, not the request. Without it, a child continues on the route the fork gives it.

A child entry is `started` with its `sessionId` once its Session exists, holds its branch record, and was sent its prompt; `queued` while it waits for a concurrency slot and has no Session; `failed` with a RemoteError `code`, a `message`, and the `sessionId` when the Session was created before the failure, for example when the fork could not attach it to the source's Workspace or rejected `selection`; or `cancelled` when the Loom service unloaded while the call waited for the set's first admissions and withdrew the child before it had a Session. One failed child leaves the others running. A retry with the same `requestId` for the same Session returns the first result and creates nothing; a request that failed validation created nothing, so its retry is validated again.

These failures happen before any fork:

| Code | Cause |
|---|---|
| `session/not-found` | The addressed Session does not exist. |
| `remote-access/denied` | The caller may not branch the existing fork parent that a first-own-turn `regenerate` or `edit` branches from; `details.action` is `loom/branch`. |
| `gateway/bad-request` | `count`, `samples`, or the number of `lines` is not a positive integer. |
| `loom/too-many-branches` | The request asks for more than `maxBranchesPerRequest` children; `details` carry `requested` and `limit`. |
| `loom/empty-line` | A line, or the edit text, has no non-whitespace character; `details.index` names it. |
| `loom/turn-unavailable` | `details.reason` is `not-found` (no such turn), `not-ended` (a `steer` or `variants` turn has no `turn/end`), `not-user-opened` (a `regenerate` or `edit` turn did not open with a user prompt), or `no-cut` (the log's first event admits that prompt, so no prefix keeps the history before it). |
| `gateway/cancelled` | The Loom service unloaded while the call read the addressed Session or the fork parent, before the set existed. |

### Follow and cancel a branch set

`setStatus({ setId })` returns the set's `sourceSessionId` and every child with its state: `started`, `queued`, `failed`, or `cancelled`, the `sessionId` of a child whose Session exists, and the `code` and `message` of a failure. A child that is being forked reads `queued`. `cancel({ setId, indices? })` withdraws queued children, every queued child when `indices` is omitted, and returns the withdrawn indices; a child that is being forked or has started is left alone. Both read Host memory: a set created before the Host restarted, or one whose `branch()` call addressed a Session the caller cannot reach, fails with `loom/set-not-found`. Started children stay findable through the fork family and their `loomBranch` values.

### Mark a Session

`mark({ sessionId, mark })` sets `keep` or `set-aside` on any Session the caller can reach, or clears it with `null`, and returns the mark in force. The Session's Agent is resumed when the Session is cold. The mark is a `plugin:loom/mark` record in that Session, flushed before the call returns; a request for the mark the Session already holds writes nothing. Marks never write feedback events. A Session that does not exist fails with `session/not-found`.

### Read a fork family

`family({ sessionId })` reads the current Session list without activating an Agent and returns the fork family of `sessionId`: the highest listed fork ancestor as `rootId`, the requested Session as `focusId`, and every listed fork descendant of the root in `nodes`. Nodes are in depth-first order, with siblings ordered by creation time and then by Session id; the creation time comes from the row's `forkLineage` list hint, and a sibling without that hint follows every sibling with one. Each node carries its depth, its parent node, its creation time when known, and the `updatedAt`, `running`, and `blank` list facts. A subagent's parent link is not a fork link, so subagent children are not family members. Only Sessions the caller may list appear. An unlisted `sessionId` fails with `session/not-found`.

The `@deepseek-ai/dsh-experimental-loom/family` export holds the same derivation without Host dependencies: `forkFamily(rows, sessionId, previous?)` takes `LoomFamilyRow` values mapped from any Session list and, given an earlier result, keeps each unchanged node reference. The browser plugin derives families from its client Session list with it and does not call `family()`.

### Read what the model saw

`requestAt({ sessionId, seq })` rebuilds one model request from the Session's whole log without activating its Agent. `seq` may name any event; the result describes the latest request whose `assistant/message` or `assistant/attempt` settlement is at or before it, so each attempt of a retried step addresses its own request. The `LoomRequestView` holds the `route` (provider, model, and reasoning effort) and tool `names` of the `request/header` in force, the tools that `developer/message` additions and removals changed in the request's turn before it, the effective `systemPrompt` text with the turn that wrote it when that was not the Session's first prompt, and every request message in model-visible order. Each message row carries its producing seq, its role (a developer message reports `system`), whether the Session inherited it from its fork source, a whitespace-collapsed preview of at most `LOOM_REQUEST_PREVIEW_MAX_CODE_POINTS` code points, and its length in code points. `inheritedTurns` and `ownTurns` count the turns started before the request on each side of the fork cut.

A seq outside the log, or before the first settlement, fails with `loom/seq-out-of-range`, whose `range` names the seqs that address a request, or is null when no request has settled. An unknown Session fails with `session/not-found`; a caller without access to the Session receives the Gateway's `remote-access/denied`.

### Branch membership and marks

`plugin:loom/branch` is an ignorable plugin record that a branch child holds before its first prompt: the set, the source Session and the seq it was cut at, the kind, the child's index, and the `variantKey` of a `variants` child. The `loomBranch` projection publishes `{ setId, kind, index, variantKey?, createdAt }` from the first valid own record, with the record's time as `createdAt`, and `null` for a Session that is not a Loom branch child. `plugin:loom/mark` records `{ version, mark }`; the `loomMark` projection publishes the last own mark as `{ mark }`, or `null`. Both units ignore records before the Session's inherited event count, which a fork of a branch or of a marked Session inherits, and records whose payload fails validation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`Loom` extends `TypertRemoteService` with service key and namespace `loom`. Its constructor registers the `loomBranch` and `loomMark` units, a `session-telemetry/record` listener, and the branch runner's teardown on its own fiber, so unloading the plugin removes all of them. The Gateway authorizes `branch()`, `mark()`, `family()`, and `requestAt()` against the addressed Session through the `sessionId` field the Session Controller registers as the `session` resource. `setStatus()` and `cancel()` name no Session, so the Gateway checks them against the `global` resource; the method then also requires `ctx.remoteAccess.allows()` on the Session the set's `branch()` call addressed, for the call's own action, so a non-owner needs both grants. `family()` filters list rows the same way.

`branch()` reads the addressed Session with `ctx.sessionController.inspect()` and resolves the request in one step, `resolveBranch()`, which returns the cut, every child's content, the next-turn prompts pending at the cut (`inheritedNextTurnPrompts()`), the browser time zone, whether the children can write, and their folder. The cut uses the Session Controller's `completedPrefixBefore()` and, for the end of the source's last completed turn, `latestCompletedPrefixBoundary()`. The prompt that opened turn k is the head of the next-turn queue at `turn/start(k)` when it entered that turn as a `user/message` from a `user` source. When a `regenerate` or `edit` names the first `turn/start` at or after a fork's inherited event count, and the fork is not a subagent child, the source is the header's `parentSession` and the cut is the inherited event count minus one; the fork's log through that cut is the parent's, so the queued prompts and sandbox mode are read from it. Without a request `selection`, the children's selection is the last `model/selection` the fork logged between its inherited events and that `turn/start`. Before any fork, the runner requires `ctx.remoteAccess.allows()` on the parent for the call's `loom/branch` action, because the Gateway authorized only the fork, and then inspects the parent, so that a caller without that grant fails with `remote-access/denied`. A parent that `inspect()` reports as `session/not-found` makes the runner resolve the request again with `redirect` false, which cuts in the addressed fork as for any other turn; any other read failure propagates. A child is writable unless the last `sandbox/mode` event through the cut, or else the composed `sandboxPolicy` default, is `read-only`; without a sandbox policy every child counts as writable. Its folder is the addressed Session's header `cwd`, which a fork copies from its parent.

The runner keeps sets in Host memory for the plugin lifetime. Admission scans the queue in order and admits each child whose slot rules allow it, so children of one set start in index order and sets start in request order; a writable child blocked by its folder does not hold back a read-only child behind it. One admission calls `ctx.sessionController.fork({ sessionId, atSeq, selection? })`, resolves the child's Agent, removes each inherited next-turn prompt with `agent.inbox.remove()`, appends the branch record with `appendPluginRecord()`, sends the prompt with `agent.followup()`, and awaits `ctx.sessions.flush()`. The slot is held from admission until the child's Agent reaches whole-agent idle after the prompt (`agent.whenIdle()`), or released at once when a step before the prompt fails. Teardown withdraws queued children and awaits every admission in flight, so no fork is left without its record and prompt. A `branch()` call waiting on its set's admissions then returns the set with the withdrawn children `cancelled`, because the admitted children run on and the caller follows them by the set id; a call that teardown overtakes before its set exists fails with `gateway/cancelled`. Tests cover each Host contract with the real agent loop and the plugin-mounted Session Controller; `branch.e2e.ts` runs regenerate and steer sets on the OpenRouter DeepSeek route.

The redaction listener calls `next()` and replaces the `body` of every `plugin:loom/*` ledger record with `null`, keeping `sourceEvent`. `requestAt()` reads `ctx.sessionController.inspect()`, the attached log or a cold read, and derives the request as the agent loop does: `foldSurface()` over the events before the settlement with `ctx.sessions.messageProjections`, `deriveEventMessage()` per surface node, and `foldRequestHeader()` for the header. The result equals the request the loop passes to `llm/stream` listeners; the host spec compares the two across a fork of a fork, a compaction-style surface replacement, and a retried step, and the Loader composition spec compares them in the shipped Web profile with the Loom bundle patch.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Loom interface Agent Note](../../../.agents/notes/proposed/feature/2026-10-18-loom-interface.md)

-----

<a id="model-experience"></a>
## Model Experience

### Branch child prompt

#### What the model sees

Each branch child's first own request ends with one `user` message that the runner sent: for `regenerate`, the content of the prompt that opened the named turn in the addressed Session, byte for byte; for `edit`, that content with its text parts replaced by one text part holding the request's `text`; for `steer` and `variants`, the request line as a single text part. The earlier messages are the source's request messages through the cut, rebuilt by the agent loop from the inherited log. A prompt the source had queued at the cut is removed and never reaches the child's requests. The branch and mark records are not model-visible.

#### Token effect

A child's first request costs the inherited prefix plus the new prompt; a request with N children sends N such requests, at most `maxConcurrentBranches` at once. Marks, status reads, and cancellation add no tokens.

#### KV Cache effect

A child's first request repeats the source's request prefix through the cut and appends the new prompt, so the provider can reuse the cached prefix when the request reaches the same cache. The Session Controller's fork gives every member of a fork family the family root's cache key. A `selection` whose route differs from the inherited route adds the agent loop's model-switch notice and is a different cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Branch sets live in Host memory only. A Host restart drops every set: its queued children never start, and `setStatus()` and `cancel()` report `loom/set-not-found`. Started children keep their Sessions and records.
- Set records and `requestId` results are kept for the plugin lifetime, one small entry per `branch()` call.
- With `concurrentWritableBranches` false, the runner serializes only the first prompt of Loom children that share a folder. The source Session, other Sessions, and later prompts in a child still write the same folder concurrently; isolated worktrees per child are deferred to a later stage.
- A child's slot lasts until its Agent reaches whole-agent idle, so prompts a user sends to a running child extend it.
- A child's prompt is a new message with a new id, not the source message. A `regenerate` re-sends stored image and file references without a new upload receipt; a file reference that the Agent must bind again was not verified.
- `mark()` resumes a cold Session's Agent to append the record.
- Loom records are experimental plugin records. A Session format migration keeps them only on a best-effort basis; a dropped `plugin:loom/branch` record makes `loomBranch` report the Session as an ordinary fork, and a dropped `plugin:loom/mark` record clears its mark.
- `family()` reads the whole Session list on each call and stops at a parent that is hidden, deleted, or outside the caller's access, so such a family is rooted at its highest visible ancestor.
- Exported telemetry still carries each Loom record's envelope, including its type and seq; only the payload is removed.
- `requestAt()` describes the request the agent loop built, before the provider route projects it: a route without tool-update support receives the messages without developer rows and learns tool changes only from the tool list, and file and offloaded image blocks reach every route as handle text.
- `requestAt()` reads and folds the whole log on every call and returns every message and the complete system prompt text, without paging.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
