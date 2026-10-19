---
description: "Five tools that let a weaver model branch Sessions through Loom, read the branches, and keep or archive them under per-weaver budgets."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-loom

English | [中文](README.zh.md)

## Summary

This package gives the model five autoloom tools over the experimental Loom service: `loom_expand` branches a Session into child Sessions after one of its turns, `loom_wait` waits for a branch set, `loom_read` reads a child's latest output, `loom_keep` marks a child as kept, and `loom_cull` stops a child and archives it. The Session whose model calls them is the weaver. Each weaver has a branch budget, a depth budget, and an own-token budget, and a child that the weaver started cannot use the tools itself. The package is published under its experimental name and provides no stability guarantee.

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

Mount this package beside `@deepseek-ai/dsh-experimental-loom` in a composition that also has the Session Controller, the Workspace registry, the permission presets, the token meter, and Session query, as the Web profile does. Every Session then sees the five tools; a Session becomes a weaver by calling them.

### When to choose it

Choose it when a model should explore alternatives on its own: write several continuations, read them, and keep the best, with every branch a real fork Session that people can open, compare, and continue. Avoid it where the branches would write the same files without isolation, because the children share the source's folder unless Loom's `defaultIsolation` gives each one a worktree.

### Smallest working example

Insert the plugin after the Loom service:

```yaml
- id: tool-loom
  name: '@deepseek-ai/dsh-experimental-tool-loom'
  config:
    autoloom:
      maxBranches: 8
      maxDepth: 2
      maxOwnTokens: 2000000
      childPermissionPreset: auto
```

| Field | Default | Meaning |
|---|---|---|
| `autoloom.maxBranches` | `8` | Most children one weaver may start |
| `autoloom.maxDepth` | `2` | Deepest generation of children; a child of a Session the weaver did not start is generation 1 |
| `autoloom.maxOwnTokens` | `2000000` | Most tokens the weaver's children may use in their own requests, summed |
| `autoloom.maxUsd` | Omitted | Optional list-price dollar ceiling; routes without configured prices are refused |
| `autoloom.childPermissionPreset` | `auto` | Permission preset every child runs with; its approval policy must be `never` |
| `defaultWaitMs` / `maxWaitMs` | `120000` / `1800000` | Wait of `loom_wait` without a timeout, and the longest accepted |
| `defaultReadChars` / `maxReadChars` | `4000` / `20000` | Output length of `loom_read` without a limit, and the longest accepted |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-tool-loom) is the exhaustive source for every accepted field and its JSDoc. The `auto` preset exists only while the experimental auto-review plugin is loaded; without it, configure a preset whose approval policy is `never`, such as `{ sandbox: read-only, approval: never }`. A configured preset other than `auto` that asks for approvals, or that does not exist, fails the plugin load.

Try it by asking a model: "Session S holds the opening line of a story. Explore two continuations of it, keep the better one, and archive the other." The model calls `loom_expand`, `loom_wait`, `loom_read` twice, `loom_keep`, and `loom_cull`.

### What the model can do

- **Branch** — `loom_expand` names a Session, the last turn every child keeps (`afterTurn`), and either `lines`, one prompt per child, or `count`, which resends the opening prompt of turn `afterTurn + 1` that many times. The target is a Session with the same working directory, or the weaver itself when `sessionId` is omitted.
- **Follow** — `loom_wait` waits for every child of a set to finish its turn, fail, or be withdrawn, and reports each child's state and own tokens. `loom_read` returns a child's latest assistant output, bounded by `maxChars`.
- **Decide** — `loom_keep` sets Loom's private `keep` mark on a child. `loom_cull` stops a running child and archives it; the archive keeps its history, and a person can restore it from the sidebar.

Only the weaver's own sets and children are readable, keepable, and cullable through the tools. Each child runs with the configured permission preset, applied before its prompt, so a child never waits for an approval that no one answers.

When `maxUsd` is configured, each expansion requires a priced estimate that fits the remaining list-price budget. The watcher stops children if their settled own usage crosses that budget or becomes unpriced. Provider charges can differ from list prices.

### What success and failure look like

Every result is compact JSON with the remaining budget: `branchesLeft`, `ownTokensLeft`, and `maxDepth`. A refused call creates, stops, and archives nothing, and its error text says why, for example `This Session may start 1 more branches, not 2; no branch was created.` or `These branches would be generation 3 of this Session's branches; the limit is 2. No branch was created.` A request that Loom rejects returns Loom's message, such as `session "S" cannot branch at turn 7: not-found`. A child that failed to start appears in the result with `state: "failed"` and its error; it counts against `maxBranches` only when its Session exists.

When the children's own tokens pass `maxOwnTokens`, every running child is stopped with the cancellation reason `loom: autoloom own-token budget exceeded`, queued children are withdrawn, `loom_wait` and `loom_read` report `stoppedByBudget: true`, and every later `loom_expand` is refused.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the tools keep their promises and points at the code; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Loom owns branching.** `loom_expand` builds a `steer` request for `lines` or a `regenerate` request of turn `afterTurn + 1` for `count`, and calls the Loom service's Host-only `branchFor`. Loom keeps every cut rule, admission limit, retry identity, and branch record; the tool adds the budgets, the `loom` prompt source, and the child preparation.
- **Decisions are logged by the weaver.** Every expansion, read, keep, and cull is a tool call and result in the weaver's log, so no new Session event is needed.
- **Refuse before forking.** Branch, depth, and own-token budgets, the target's working directory, and the child preset are checked before Loom is called, so a refusal leaves no fork.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config`, the load-time checks, and registration |
| [`src/tools.ts`](src/tools.ts) | The five tool registrations |
| [`src/schemas.ts`](src/schemas.ts) | Parameter and result schemas |
| [`src/runtime.ts`](src/runtime.ts) | Weaver runs, budgets, the own-token watcher, waits, reads, keeps, and culls |
| [`src/presentation.ts`](src/presentation.ts) | Host card presenters |
| [`src/types.ts`](src/types.ts) | The `loom` message source and the `autoloom/child-refused` error code |

### Runs and budgets

A run holds every set and child one weaver Session started while the plugin is loaded, keyed by the weaver's Session id, so an unloaded and resumed weaver keeps its budget. `maxBranches` counts every requested child except those Loom reported failed without a Session. A child's generation is the number of the weaver's own children among the target and its fork ancestors, plus one, read from Session query lineage, so a person's fork of a child counts too. The call id of `loom_expand` derives Loom's request identity, so a repeated call returns the first set and counts it once.

Unloading the tools aborts pending reads, wakes waits, stops their running children with the hook reason `loom: autoloom tools unloaded`, withdraws queued children, and drains in-flight admissions and child activity before clearing run state. A child whose admission already created a Session is retained without a prompt if preparation sees the unload. Completed children remain available, and a person may prompt them after the tools unload.

### Child preparation

Loom calls the tool's preparation for each child after its `plugin:loom/branch` record and before its prompt. The preparation applies the child preset through the permission presets, records the child in the run, and marks it as an autoloom child. A child admitted after the run's budget ran out or after the plugin unloaded fails there with `autoloom/child-refused` and gets no prompt.

### Own-token watcher

The runtime subscribes to projection changes of the token meter's `tokenUsage` unit. For a run child it reads the fork's own subtotal, the sum of uncached input, cache reads, cache writes, and output, and when the run's total passes `maxOwnTokens` it cancels every running child with the `hook` cause and asks Loom to withdraw the run's queued children. The watcher runs inside a Session commit, so a failed withdrawal is logged, never thrown.

### Autoloom children

A Session whose first own prompt carries the `loom` source is an autoloom child, and every tool refuses to run in it, so a child cannot start a run of its own with a fresh budget. The check reads the caller's log once and caches the answer when the first own prompt exists.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Loom package](../loom/README.md) — branch sets, cuts, admission limits, records, and marks.
- [Loom subsystem](../../../docs/subsystems/loom.md) — the `loom` Remote and Host types.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-loom) — every tool schema the model receives.
- [Loom interface Agent Note](../../../.agents/notes/implemented/feature/2026-10-18-loom-interface.md) — the staged plan; autoloom is L24.

-----

<a id="model-experience"></a>
## Model Experience

### Autoloom tool schemas

#### What the model sees

Every Session in a composition that mounts the plugin receives the five schemas listed in the generated [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-tool-loom). The `timeoutMs` description of `loom_wait` and the `maxChars` description of `loom_read` state the configured defaults and maximums. Results are compact JSON objects, and a refusal is the tool's error text.

#### Token effect

The five schemas add a fixed cost to every request of every Session where the plugin is mounted. Each result is one compact JSON object: `loom_expand` and `loom_wait` grow with the number of children in the set, and `loom_read` carries at most `maxChars` code points of output.

#### KV Cache effect

The schemas are the same for every Session of one configuration, so a branch child repeats its source's tool prefix. Changing `defaultWaitMs`, `maxWaitMs`, `defaultReadChars`, or `maxReadChars` changes schema text and the cached prefix of every Session. Tool results append after the reusable prefix.

### Autoloom child prompt

#### What the model sees

A child's first own request ends with one `user` message that the weaver sent: the `loom_expand` line verbatim, or for `count`, the content of the prompt that opened turn `afterTurn + 1` in the target. The `loom` source on that message is not model-visible. The child's earlier messages are the target's request messages through the cut, as Loom forks them.

#### Token effect

Each child's first request costs the inherited prefix plus the new prompt; the children's own requests count against `maxOwnTokens`, and the weaver's own requests do not.

#### KV Cache effect

A child repeats the target's request prefix through the cut, and the Session Controller's fork keys every member of a fork family by the family root, so the provider can reuse the cached prefix. The child preset writes knob events into the child's log before its prompt; those events are not model-visible.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Runs live in Host memory** — a Host restart or a plugin reload forgets every run: the budgets start again, and the tools refuse children and sets of earlier runs, which stay readable in the Loom tab.
- **`count` resamples only turns a person opened** — Loom regenerates a turn only when a `user` prompt opened it, so `count` on a turn a weaver opened fails with Loom's `not-user-opened`; branch a child with `lines` instead.
- **The own-token watcher acts per committed response** — a child is stopped after the response that passed the budget, so the last response can overshoot `maxOwnTokens` or `maxUsd`, and an uncapped child response is not cut short.
- **A queued child whose fork fails wakes no wait** — `loom_wait` reports it when another child changes state or when the wait times out.
- **Every Session sees the tools** — the schemas cost tokens in Sessions that never weave; only autoloom children are refused.
- **No Web card** — Host presenters give generic cards with past-tense titles.
- **Needs the Web composition** — `loom_cull` archives through the Workspace registry, which the headless profile does not mount.
- **Experimental prototype with no stability promise** — schemas, limits, and the `loom` source can change while the package incubates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
