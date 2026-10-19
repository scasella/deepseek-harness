---
description: "Enable experimental Loom branching from the plugin manager."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-loom-bundle

English | [中文](README.zh.md)

## Summary

This optional bundle enables Loom branching, worktree isolation, comparison, and model-driven exploration. Loom treats forked Sessions as a tree of branches: a fork shows a band at its cut and a variant chip in the conversation header, and every Session gains a Loom tab that reads the fork family. The installation ships the bundle switched off; no profile template selects it, and the plugin manager lists it under More until it is switched on.

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

Open **Plugins** in the Web sidebar, select **More** beside **Experimental plugins**, and switch on **Loom**; once on, it also appears on the main list. The bundle enables Multiverse content search through an in-memory SQLite index opened on first search; profiles without Loom keep content search off. The bundle has no configuration form; configure its plugins through profile overlays. Autoloom children use the bundled `loom-child` permission preset, which permits reads without approval prompts. [`@deepseek-ai/dsh-experimental-client-ui-loom`](../client-ui-loom/README.md) describes what it shows. For development, `pnpm dsh web --patch apps/web/tests/loom.overlay.yml` composes the same rows without switching the bundle on.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The static `cordis.patch.yml` inserts the `loom` row for [`@deepseek-ai/dsh-experimental-loom`](../loom/README.md), `loom-worktree` for the worktree service, `tool-loom` for the five autoloom tools, and the `ui-loom` row for [`@deepseek-ai/dsh-experimental-client-ui-loom`](../client-ui-loom/README.md). Loom and its worktree provider share an isolated `worktrees` service, so enabling the separate Worktree bundle in either order does not register the same service twice. Optional-bundle installation makes the package available to the plugin manager without selecting it in default profiles. The browser plugin owns the generated Remote mount; stable API Remotes do not import experimental code.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Loom interface Agent Note](../../../.agents/notes/implemented/feature/2026-10-18-loom-interface.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the composed [autoloom tools](../tool-loom/README.md#model-experience), which let a model expand, wait for, read, keep, and archive branches under configured budgets.

#### KV Cache effect

The five tool schemas join model requests. Branches share their fork family’s prompt-cache key.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The bundle icon awaits designer approval.
- Loom records are experimental plugin records that a Session format migration keeps only on a best-effort basis.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
