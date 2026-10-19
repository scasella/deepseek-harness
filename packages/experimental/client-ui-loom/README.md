---
description: "Use and debug the experimental Loom browser plugin: the loom Remote mount, its locale namespace, and fork-family sources."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-loom

English | [中文](README.zh.md)

## Summary

This package is the browser half of Loom. It mounts the generated `loom` Remote contribution of [`@deepseek-ai/dsh-experimental-loom`](../loom/README.md), registers the `loom` locale namespace, and owns fork-family sources keyed by Session id that derive each family from the client Session list. It registers no slot entry, so enabling it changes nothing visible. Choose it through [`@deepseek-ai/dsh-experimental-loom-bundle`](../loom-bundle/README.md).

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

The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no configuration fields. The plugin injects `remote`, `sessions`, and `locale`.

A fork-family source reports `loading` until the Session list has arrived, then `ready` with the family, or `unlisted` while the list does not hold the Session. A slot registration hands the sources to its component through the inject `keyedHooks` compartment under the key `loomFamily`, and the renderer binds them as `useLoomFamily(sessionId)`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`mountLoom()` mounts the Remote contribution, then registers the dictionaries and the family sources under an inner fiber that waits for `sessions` and `locale`; a failed registration withdraws the Remote. Disposing the plugin disposes the sources, then withdraws the Remote.

Each source subscribes to the client Session list when its first subscriber arrives and unsubscribes when the last one leaves. While observed, it derives the family from every ready list snapshot with `forkFamily()` from `@deepseek-ai/dsh-experimental-loom/family`, so membership, creation order, `updatedAt`, `running`, and `blank` come from the one list the Host keeps current. Rows come from the list's `ids`, the Host-list members; creation times come from each row's `forkLineage` projection value. A node whose facts did not change keeps its reference, and a snapshot that changes no node keeps the family reference. The browser does not call the Host `loom.family` read.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Loom interface Agent Note](../../../.agents/notes/proposed/feature/2026-10-18-loom-interface.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as the browser plugin renders no model input and submits nothing to an Agent.

#### KV Cache effect

No direct effect; the plugin only reads the client Session list.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A family holds only Sessions in the client Session list, so a fork parent that is hidden or deleted roots the family at its highest listed ancestor.
- A sibling whose list row carries no `forkLineage` value sorts after its siblings until that value arrives.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
