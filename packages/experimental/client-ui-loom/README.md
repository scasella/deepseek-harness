---
description: "Use and debug the experimental Loom browser plugin: the fork band, the header variant chip, and the Loom tab with its family tree and reading pane."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-loom

English | [中文](README.zh.md)

## Summary

This package is the browser half of Loom. In a fork it shows a band at the cut that names the parent and the variants forked at the same cut, and a "Variant k of N" chip in the conversation header. On every Session it adds a Loom view tab that outlines the fork family as a keyboard-navigable tree beside a read-only document of the selected Session's path, including what the model saw for each turn. It mounts the `loom` Remote of [`@deepseek-ai/dsh-experimental-loom`](../loom/README.md). Choose it through [`@deepseek-ai/dsh-experimental-loom-bundle`](../loom-bundle/README.md).

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

The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no configuration fields. The plugin injects `remote`, `sessions`, and `locale`; its slot entries wait for the mounted `remote.loom` namespace, `slots`, `uiConversation`, and `uiWorkspace`, and its shortcut reference rows wait for `shortcuts`.

| Slot | Entry | Shows |
|---|---|---|
| `conversation.chat.fork-cut` | `loom-fork-band`, order 0 | "Branched from *parent* after turn *N*", an Open parent link, and one chip per variant at the cut, the current one marked with `aria-current`; nothing for a subagent child |
| `conversation.session.header.actions` | `loom-variant`, order −30 | "Variant *k* of *N* · after turn *N*" with a menu of the variants; hidden for fewer than two variants and in a header narrower than 480px |
| `conversation.view` | `loom`, order 20, after Trajectory | The Loom tab in Read mode |

Variants are the family members with the same fork parent and the same cut seq, numbered by `forkLineage.createdAt` and then Session id. A cut inside a turn reads "during turn *N*": the band takes the turn from Chat's `inheritedTurn`, and the header chip and the tree from the parent's `turnOutline`. A cut before any turn started reads "before turn 1 ended". The chips stay in one row at every width and scroll sideways, keeping the current chip in view and fading an end that hides chips; below 480px the band also puts the parent title on its own line and drops the Variants caption. A truncated parent or chip title shows in full in a tooltip.

### The Loom tab

The tree pane lists the family root, one branch-point row per cut under each parent ("After turn *N*" or "During turn *N*", with its branch count and the children's own tokens), and each child with its own turns, own steps, own tokens, and a status dot; a fork without own turns reads "no turns yet". Each level indents 19px, and guide lines join every row to its parent. Rows on the path to the current Session carry an accent rule, and the current Session carries `aria-current`. The key hints sit at the bottom of the tree pane. The tree is an APG outline tree with one tab stop: Up and Down move, Home and End jump, Right expands a row or enters its first child, Left collapses a row or moves to its parent, and Enter or Space reads a Session or toggles a branch point. The keys act only while a tree row has focus, and the disclosure chevron is a pointer target that leaves focus on its row. The shortcut reference lists the tree keys under its tree group. While the panes sit side by side, the floating composer spans only the reading pane through ui-conversation's `insetComposerStart`; stacked below 720px, it spans the tab.

The reading pane shows the selected Session, the current one by default. A fork starts with its inherited turns collapsed to the first prompt and the last response as plain text, then the cut, then each loaded own turn; a fork-mode subagent child splits its inherited and own turns at the same point as Chat, without a cut line. Each own turn shows the prompt, a "What the model saw for this turn" disclosure, the closing reasoning collapsed with the turn's reasoning-token count, and the reply. The disclosure reads `loom.requestAt` for the turn's closing `assistant/message` when opened and shows the system prompt length and whether that turn rebuilt it, the tool count with tools added or removed in that turn, inherited and own turns with their steps while the Session's statistics cover the same turns, the turn's own usage (new input, cached, and output tokens), and the message count with the route on one line. The token count is hidden when a provider did not report reasoning tokens for every attempt. "Open in Chat" opens a selected Session other than the current one. A view request addressed to `loom` names a Session to read: the tab reads it when it belongs to the family and acknowledges the request once the family has loaded.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`mountLoom()` mounts the Remote contribution, then registers under two inner fibers: one waiting for the slot services and `remote.loom` registers the dictionaries, the sources, and the three slot entries; one waiting for `shortcuts` registers the tree's fixed reference rows. A failed registration disposes both fibers and withdraws the Remote. Disposing the plugin disposes the fibers, then withdraws the Remote. The view entry declares the tab store (the selected Session, collapsed rows, and the row holding the tab stop), so the framework keeps one per Session and the state survives switching tabs.

The entries read through three keyed sources bound as `useLoomFamily`, `useLoomReader`, and `useLoomRequest`:

- A family source subscribes to the client Session list while observed and derives the family with `forkFamily()` from `@deepseek-ai/dsh-experimental-loom/family`, from the list's `ids` and each row's `forkLineage` creation time. Unchanged nodes and families keep their references.
- A reader source retains its Session with the reference source `loom` while observed, follows the Session's Chat target, and folds the loaded turns: the opening user text, the closing assistant text and reasoning, the closing `assistant/message` seq, and the Turn tail's reasoning tokens and usage. Its last unsubscribe releases the Session.
- A request source calls `loom.requestAt` on its first subscriber and aborts a pending read when the last one leaves.

Each source leaves its registry on its last unsubscribe, so nothing a reader stopped viewing stays in memory; the next observation of that key creates a fresh source that reads again. Failures name `session/not-found`, `loom/seq-out-of-range`, and `remote-access/denied`; other codes appear verbatim.

Fork facts come from the list's projection values: `forkLineage` for the cut, `sessionStats.fork` for own and inherited counts, `tokenUsage.fork` for own tokens, and `turnOutline` for the inherited preview. Each entry asks once per mount for the projections of a member that lacks them.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Loom interface Agent Note](../../../.agents/notes/proposed/feature/2026-10-18-loom-interface.md)
- [Chat conversation UI](../../client/ui-chat/README.md) — the inherited-span disclosure and the `conversation.chat.fork-cut` seat.

-----

<a id="model-experience"></a>
## Model Experience

None, as the browser plugin renders logged Session data and submits nothing to an Agent.

#### KV Cache effect

No direct effect; the plugin only reads Session lists, Session histories, and logged requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A family holds only Sessions in the client Session list, so a fork parent that is hidden or deleted roots the family at its highest listed ancestor.
- A sibling whose list row carries no `forkLineage` value sorts after its siblings until that value arrives.
- The view registry lists the Loom tab on every Session while the bundle is on, so every Session shows a tab strip.
- The reading pane is a read-only summary of the loaded turns, not the Chat transcript: tool calls and intermediate steps are omitted, and the reasoning shown is the closing step's. An embedded Chat would render a composer for the read Session and nest the current Session inside its own tab.
- Reading a Session other than the current one opens its history in the browser while the pane shows it.
- The tree shows own tokens rather than own cost, because Loom has no pricing configuration yet.
- The fork band appears only while the cut lies in Chat's loaded window; the header chip does not depend on the window.
- The zh copy awaits translator review.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
