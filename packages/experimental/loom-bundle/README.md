---
description: "Enable experimental Loom branching from the plugin manager."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-loom-bundle

English | [中文](README.zh.md)

## Summary

This optional bundle composes the Loom Host service and its browser plugin. Loom treats forked Sessions as a tree of branches. The installation ships the bundle switched off; no profile template selects it, and the plugin manager lists it under More until it is switched on.

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

Open **Plugins** in the Web sidebar, select **More** beside **Experimental plugins**, and switch on **Loom**; once on, it also appears on the main list. The bundle has no configuration form, and neither composed plugin has configuration fields. Enabling it adds no visible control, because the browser plugin registers no slot entry.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The static `cordis.patch.yml` inserts the `loom` row for [`@deepseek-ai/dsh-experimental-loom`](../loom/README.md) and the `ui-loom` row for [`@deepseek-ai/dsh-experimental-client-ui-loom`](../client-ui-loom/README.md). Optional-bundle installation makes the package available to the plugin manager without selecting it in default profiles. The browser plugin owns the generated Remote mount; stable API Remotes do not import experimental code.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Loom interface Agent Note](../../../.agents/notes/proposed/feature/2026-10-18-loom-interface.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as the composed plugins read Session lists and Loom records without adding model-facing content.

#### KV Cache effect

No direct effect; the bundle adds no model request content.

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
