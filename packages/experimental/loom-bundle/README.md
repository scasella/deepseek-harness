---
description: "Enable experimental Loom branching from the plugin manager."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-loom-bundle

English | [中文](README.zh.md)

## Summary

Explore alternative agent tasks and prose without losing the other branches. This optional bundle adds the Loom tree and reader, Compare with worktree actions, Weave with token exploration and export, Multiverse search, and budgeted autoloom tools. Enable it in the Web plugin manager; it is off by default. Use a matching Harness build containing the required core APIs.

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

Open **Plugins** in the Web sidebar, select **More** beside **Experimental plugins**, and switch on **Loom**. Follow the [Loom guide](../../../docs/user/guide/loom.md) to branch, compare, continue, and export. The coordinated Harness release must include the bundle and the matching core changes; the already published `0.2.1-rc.2` runtime does not provide those APIs.

### Source-checkout installation

From a prepared source checkout containing Loom, add its local bundle to the Web profile:

```sh
pnpm dsh plugin --profile web add link:./packages/experimental/loom-bundle --offline
pnpm dsh web --dump-config
```

The dump includes `loom`, `loom-worktree`, `tool-loom`, and `ui-loom`. The package manager may warn about the linked Cordis peer; in-box bundles and their dependencies resolve from the Harness installation. The command uses the selected `DSH_HOME`; use a disposable home for a trial. Remove the layer with:

```sh
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-experimental-loom-bundle
```

Removal withdraws Loom from the composed profile and retains Session files. Start the Web profile again to load the changed composition. These source commands do not claim npm availability of the unreleased feature.

### Configuration and permissions

The bundle has no configuration form; configure the [Loom service](../loom/README.md) and [autoloom tools](../tool-loom/README.md) through profile overlays. Autoloom children use the bundled `loom-child` preset: read-only with no approval prompts. Worktree branches require a Git repository and workspace-write permission. No prices ship by default; configured costs are list prices.

Multiverse content search uses an in-memory SQLite index opened on first search; profiles without Loom keep content search off. The bundle also writes the permission preset configuration, so a later overlay that changes it must retain the presets it still needs.

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

- [Loom guide](../../../docs/user/guide/loom.md) — task-oriented Web walkthrough.
- [Loom service](../loom/README.md) — isolation, pricing, records, and limits.
- [Loom interface Agent Note](../../../.agents/notes/implemented/feature/2026-10-18-loom-interface.md) — decision rationale.

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
- Host restarts lose queued branch admissions, autoloom budgets, warm-prefix hints, and download URLs. Started Sessions, recorded prose, and choices remain.
- Adopt and archive retain worktrees; Apply and Discard perform explicit cleanup.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
