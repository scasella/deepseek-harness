---
description: "Use the experimental Loom Host service: fork families, Loom branch records, and the loom Remote."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-loom

English | [中文](README.zh.md)

## Summary

The `ctx.loom` service holds the Host half of Loom, which treats forked Sessions as a tree. It exposes the `loom` Remote namespace, declares the `plugin:loom/branch` record, publishes each Session's fork cut and branch membership as the `loomBranch` projection, and removes Loom record payloads from exported telemetry. Enable it through [`@deepseek-ai/dsh-experimental-loom-bundle`](../loom-bundle/README.md).

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

Compose the row with the Session Controller, the Session projection registry, Remote access, and Typert; the Web profile supplies all four. The package has no configuration fields. The browser half, [`@deepseek-ai/dsh-experimental-client-ui-loom`](../client-ui-loom/README.md), mounts this package's generated `/remote` contribution.

### Read a fork family

`family({ sessionId })` reads the current Session list without activating an Agent and returns the fork family of `sessionId`: the highest listed fork ancestor as `rootId`, the requested Session as `focusId`, and every listed fork descendant of the root in `nodes`. Nodes are in depth-first order, with siblings ordered by creation time and then by Session id; the creation time comes from the row's `forkLineage` list hint, and a sibling without that hint follows every sibling with one. Each node carries its depth, its parent node, its creation time when known, and the `updatedAt`, `running`, and `blank` list facts. A subagent's parent link is not a fork link, so subagent children are not family members. Only Sessions the caller may list appear. An unlisted `sessionId` fails with `session/not-found`.

The `@deepseek-ai/dsh-experimental-loom/family` export holds the same derivation without Host dependencies: `forkFamily(rows, sessionId, previous?)` takes `LoomFamilyRow` values mapped from any Session list and, given an earlier result, keeps each unchanged node reference. The browser plugin derives families from its client Session list with it and does not call `family()`.

### Branch membership

`plugin:loom/branch` is an ignorable plugin record that a branch child holds before its first prompt: the branch set, the source Session and seq it was cut from, its position in the set, and how the set was derived. The `loomBranch` projection publishes `{ inheritedEventCount, branch }`, where `inheritedEventCount` is the number of events the Session inherited and `branch` is the first valid own record. Records before that count are inherited from the fork source and never count as membership; a payload that fails validation is ignored.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`Loom` extends `TypertRemoteService` with service key and namespace `loom`. Its constructor registers the `loomBranch` unit and a `session-telemetry/record` listener on its own fiber, so unloading the plugin removes both. The Gateway authorizes `family()` against the addressed Session through the `sessionId` field the Session Controller registers as the `session` resource; the method then filters list rows through `ctx.remoteAccess.allows()`. The redaction listener calls `next()` and replaces the `body` of every `plugin:loom/*` ledger record with `null`, keeping `sourceEvent`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Loom interface Agent Note](../../../.agents/notes/proposed/feature/2026-10-18-loom-interface.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as the service reads Session lists and Loom plugin records, which never enter model requests.

#### KV Cache effect

No direct effect; plugin records stay outside the model-visible surface.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Loom records are experimental plugin records. A Session format migration keeps them only on a best-effort basis; a dropped `plugin:loom/branch` record makes `loomBranch` report the Session as an ordinary fork.
- `family()` reads the whole Session list on each call and stops at a parent that is hidden, deleted, or outside the caller's access, so such a family is rooted at its highest visible ancestor.
- Exported telemetry still carries each Loom record's envelope, including its type and seq; only the payload is removed.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
