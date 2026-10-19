---
description: "Use and debug the experimental Loom browser plugin: the fork band, the header variant chip, branching from a turn with a folder and cost choice, private marks, and the Loom tab with its family tree, reading pane, and branch comparison."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-loom

English | [中文](README.zh.md)

## Summary

This package is the browser half of Loom. A fork shows a band at its cut and a "Variant k of N" header chip. A completed turn gains Branch ×N and Regenerate ×N with a folder choice and cost estimate, a sibling pager, and private marks; a user message gains Edit & branch, and a dock strip follows running branches. Every Session gains a Loom tab: a family tree beside a reading pane, and a Compare mode that adopts a branch, applies its worktree change, or discards its worktree. It mounts the `loom` Remote of [`@deepseek-ai/dsh-experimental-loom`](../loom/README.md). Choose it through [`@deepseek-ai/dsh-experimental-loom-bundle`](../loom-bundle/README.md).

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

The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no configuration fields. The plugin injects `remote`, `sessions`, and `locale`; its slot entries wait for the mounted `remote.loom` namespace, `slots`, `uiConversation`, and `uiWorkspace`, its route pickers wait for the `session` Remote, and its shortcut reference rows wait for `shortcuts`.

| Slot | Entry | Shows |
|---|---|---|
| `conversation.chat.fork-cut` | `loom-fork-band`, order 0 | "Branched from *parent* after turn *N*", an Open parent link, and one chip per variant at the cut, the current one marked with `aria-current`; nothing for a subagent child |
| `conversation.session.header.actions` | `loom-variant`, order −30 | "Variant *k* of *N* · after turn *N*" with a menu of the variants; hidden for fewer than two variants; opens a bottom sheet on phones |
| `conversation.chat.assistant-actions.after` | `loom-branch-caret` 0, `loom-pager` 10, `loom-regenerate` 20, `loom-marks` 30 | The Branch ×N caret, the sibling pager, the Regenerate split button, and the Keep / Set aside group, after Branch |
| `conversation.chat.user-actions` | `loom-edit-branch`, order 10 | Edit & branch under the user message that opened its turn |
| `conversation.input.dock` | `loom-running` 14, `loom-branch-form` 16 | The running-branches strip and the Branch ×N form, between the Goal card and the queue panel |
| `conversation.view` | `loom`, order 20, after Trajectory | The Loom tab in Read, Compare, and Weave modes |

Variants are the family members with the same fork parent and the same cut seq, numbered by `forkLineage.createdAt` and then Session id. A cut inside a turn reads "during turn *N*": the band takes the turn from Chat's `inheritedTurn`, and the header chip and the tree from the parent's `turnOutline`. A cut before any turn started reads "before turn 1 ended". The chips stay in one row at every width and scroll sideways, keeping the current chip in view and fading an end that hides chips; below 480px the band also puts the parent title on its own line and drops the Variants caption. A truncated parent or chip title shows in full in a tooltip.

### Branch from a turn

The Loom actions after Branch need `loom/branch` access, and the marks need `loom/mark`. Each one starts a branch set through `loom.branch`; a set's children are new fork Sessions of this Session that the Host forks and prompts, while this Session stays unchanged.

- **Branch ×N** is the caret right after Branch on a completed turn. It opens a form in the input dock with one steering line per branch, Add branch, a note naming the rows that share a line, Samples per line (×1 to ×4), the Model row, the Workspace row, and the Cost row. Start sends a `steer` set cut at the end of the turn, or a `variants` set when each line runs more than once; the form keeps its draft and shows the failure when the Host refuses. A form opened for another family member names that Session.
- **Regenerate** is a split button on a turn opened by a user prompt. The main part regenerates the turn once; the caret opens a panel with ×1 / ×2 / ×4, the prompt it resends on one line, the Model row, the Workspace row, and the Cost row. Both parts cut before the turn's prompt and send it again, keeping its images and files. On a fork's first own turn, Regenerate and Edit & branch fork the fork's parent at the same cut instead, so the new branches appear in the pager as further variants and run on this branch's route. When that parent no longer exists, the Host cuts in this branch instead and the new branches become its children.
- **The Model row** names the route the branches inherit, "Same as this branch" or "Same as parent". Once the `session.modelCatalog` route list loads, Change offers its routable models; a choice applies to these branches only and is never saved as the default. The route reads by the catalog's model and effort names once the list loads, and by raw ids before that or for a route the catalog does not list. For Regenerate it is the route the turn's first request used, and the Session's last route only on its latest turn. For Branch ×N cut at the Session's last turn it is the pick no request used yet, else the last route used; cut at an earlier turn it is the route that turn's successor started on, else the route that turn ended on, and without either it reads "No route recorded yet".
- **The Workspace row** chooses where branches keep their files: "Run one at a time in the shared folder", the default, where children share this folder, including edits earlier branches make, or "Isolate each branch in a worktree", where each branch starts from a snapshot of this folder: its committed files and the uncommitted changes to tracked files, without untracked files. The Host reports no capability up front, so both options are offered; when the Host refuses worktrees with `loom/isolation-unavailable` (the worktree service is not running, the sandbox is read-only, no Git repository holds the folder, the repository root lies above the folder, or the folder is a linked checkout), the form or panel keeps its draft, falls back to the shared folder, and shows the worktree option disabled with the reason. The form keeps the refusal until it closes, because it is a draft the user is editing, while the Regenerate panel tries worktrees again each time it opens, because it opens cheaply and the folder may have changed since. The form and the panel always send their choice; the Regenerate button's main part sends none, so the Host's default applies.
- **The Cost row** reads `loom.estimate` while the form or panel is open, once per branch count, kind of set, and cut and never per keystroke: "≈ $a–$b per branch · list price", the total for several branches, and the share of input the family's cache is expected to serve; a route without a configured price reads in own tokens and says there is no list price, and an estimate is never read as zero dollars. The estimate names the selected route and is read again when that selection changes. When the estimate cannot be read, the Regenerate panel shows the turn's own usage instead and the form shows no Cost row.
- **The sibling pager** "‹ k/N ›" sits on a fork's first own turn when the fork has variants: family members with the same parent and cut, numbered as in the band. It is one tab stop; Left and Right move between its buttons, and Home and End open the first and last variant. Below 480px it takes its own row with 44px buttons and reads "Variant k of N".
- **Keep and Set aside** form their own group on the latest loaded turn of a Session in a fork family. They are toggles with `aria-pressed` that write `loom.mark` records, never Like or Dislike feedback; the pressed state follows the `loomMark` projection and, while a save is in flight, the mark being saved. Each carries its hint, private and never sent as feedback, as its accessible description.
- **Edit & branch** under the user message that opened a turn opens a panel with the message's text in an inline editor. Enter or Branch sends an `edit` set that cuts before the message, replaces its text, and keeps its images and files; the new branch opens once it starts.
- **The running strip** in the input dock lists every child of the sets this Session started or branched while one runs, waits for approval, is queued, or failed: running, needing approval, ended, queued, or failed with its reason and a next step. A row is named by its steering line or "Branch *n*", never by the Session's title, which steer and variants children inherit from the source. It counts each state, opens a started child, and withdraws one queued child or all of them through `loom.cancel`. A queued child turns into its Session once the family lists a member whose `loomBranch` names the same set and index. A set with only ended and failed children stays until Dismiss.

Labelled buttons keep their glyphs and move their names to the accessible name and tooltip when the Chat scroller is narrower than 736px; on a device that does not hover, Keep and Set aside keep their names and wrap instead, because no tooltip shows there. Tooltips appear only on devices that hover. The Regenerate and Edit & branch panels take focus once placed, on the checked count or the editor, and Escape, Cancel, or a started branch returns focus to the button that opened the panel. The Branch ×N form closes on Escape unless a route menu inside it is open, and Cancel, Escape, or a started branch returns focus to the caret that opened it, or to the Loom tree's tab stop when the form came from the tree.

### The Loom tab

The tree pane lists the family root, one branch-point row per cut under each parent ("After turn *N*" or "During turn *N*", with its branch count and the children's own tokens), and each child with its own turns, own steps, own tokens, and a status dot; a fork without own turns reads "no turns yet". Each level indents 19px, and guide lines join every row to its parent. Rows on the path to the current Session carry an accent rule, and the current Session carries `aria-current`. The key hints sit at the bottom of the tree pane. The tree is an APG outline tree with one tab stop: Up and Down move, Home and End jump, Right expands a row or enters its first child, Left collapses a row or moves to its parent, and Enter or Space reads a Session or toggles a branch point. g opens the Branch ×N form in this tab's dock: for a Session row it branches after that Session's last ended turn, and for a branch point after the point's turn, unless the cut lies inside a turn. k and x toggle Keep and Set aside on a Session row. The keys act only while a tree row has focus, and the disclosure chevron is a pointer target that leaves focus on its row. The shortcut reference lists the tree keys under its tree group. A marked Session shows its mark after its title, an adopted branch shows "adopted", and a branch point shows how many of its children run. Under the tree, each branch point with a prompt-variant set lists every line with its samples and how many of them are kept or set aside. While the panes sit side by side, the floating composer spans only the reading pane through ui-conversation's `insetComposerStart`; stacked below 720px, it spans the tab.

The reading pane shows the selected Session, the current one by default, with an Adopted tag on an adopted branch. A fork starts with its inherited turns collapsed to the first prompt and the last response as plain text, then the cut, then each loaded own turn; a fork-mode subagent child splits its inherited and own turns at the same point as Chat, without a cut line. Each own turn shows the prompt, a "What the model saw for this turn" disclosure, the closing reasoning collapsed with the turn's reasoning-token count, and the reply. The disclosure reads `loom.requestAt` for the turn's closing `assistant/message` when opened and shows the system prompt length and whether that turn rebuilt it, the tool count with tools added or removed in that turn, inherited and own turns with their steps while the Session's statistics cover the same turns, the turn's own usage (new input, cached, and output tokens), and the message count with the route on one line. The token count is hidden when a provider did not report reasoning tokens for every attempt. "Open in Chat" opens a selected Session other than the current one. A view request addressed to `loom` names a Session to read: the tab reads it when it belongs to the family and acknowledges the request once the family has loaded.

A Read | Compare switch above the panels changes the tab's mode; the mode, the branch point, and the picked branch stay when the user switches between the Chat and Loom tabs. Compare hides the tree and the reading pane and lists the branches forked at one cut through `loom.compare`: the cut of the selected Session, else its latest cut with children, with a picker for the family's other cuts. It reads when it opens and again whenever a branch at the cut starts or ends, with no timer. Each row shows the branch's title and steering line, the tests parsed from its own command output (the command in a tooltip, or "no test run found"), the lines and files it changed, its own steps, its own cost at list price or in tokens when the route has no price, its wall time, and the Keep and Set aside marks, which follow the tree's. A row says when it runs, was adopted, or ran in a worktree. The table never ranks rows and shows no "best" badge; it notes which rows report the same test results and whether their changes differ, and whether the branches ran in the shared folder or in worktrees. Below 720px each row stacks into a card and the marks show their names.

A radio picks a row, which expands to its diff (`loom.diff`, drawn in a `DiffBlock` with one tab per changed file) and its actions. Adopt, offered only on a picked row, makes the branch the main line: the Host records the choice in that branch only and archives the other branches, stopping running ones first, and deletes nothing. Apply diff to folder, for worktree branches, asks for confirmation naming the files, writes the branch's change into the source folder, and removes the worktree; the Host refuses a source folder with changes in the way or a change that conflicts with it, naming the paths, and refuses a change over its size limit. Continue here opens the branch in Chat. Discard worktree removes, after confirmation, a worktree the Loom service created and keeps the Session and its log. Apply and Discard wait for a running branch to end, and a branch that shares the folder has neither, because its changes are already in the folder. Every action reads the comparison again.

-----

### Multiverse, prose, and token inspection

The sidebar's Multiverse page lists fork families across Sessions. Search targets the selected family ids before ranking and the result cap; Own messages is the page default, with Inherited messages and All history available. The standard sidebar search keeps its existing scope.

Weave edits a prose document at an exact cursor, then requests N continuations. Preview leaves the document unchanged; Choose records a curation choice and keeps every sibling. The retained-request selector reopens every recorded request, including unchosen sets; model blocks also reopen their original alternatives. Unsubmitted prose, its exact attribution and cursor, and generation controls survive switching panels or conversation tabs. Up and Down preview candidates, 1–9 choose a completed candidate, and g generates while focus is outside editor controls. The local model row, explicit thinking-off label, temperature control, and list-price preview describe auxiliary prose calls without changing the Session route. Price ranges use historical input for that route and the requested output cap, and identify whether the cursor text matches that history. Typed refusals explain capability, limit, route, access, and busy recovery. The meter shows the persisted sum of log₂(N) for Weave choices only. The export dialog downloads the current path, its siblings, or kept agent branches as HTML, text, or JSON through an authorized Host route.

Captured answer probabilities appear in a separate disclosure in the reading pane and directly on Weave text. Only exact recorded token/text matches are annotated. Dotted underlines and written percentages accompany probability shading; reasoning and uncaptured text stay plain. Token alternatives and the bounded token multiverse continue only through the Host's logged auxiliary prose requests. The block explorer uses cumulative probability for height and groups children inside the parent interval; written path selection has full-size touch targets, and the selected subtree shows probability, magnification, and information. Hatching names unshown mass only at positions actually probed, including alternatives outside the returned top tokens; blank space never means zero probability. A phone-sized variant chip opens the shared bottom sheet, with full sibling titles and visible controls.

Settled top-level tool results offer Edit result & branch. The editor replaces only result text in a new fork, then continues without running the tool again. A partially completed Host write links the created child. The five autoloom tool cards derive status, budgets, links, and output from recorded raw result content and retain unrecognized or failed output as text. After Apply or Discard removes a worktree, its Session history remains readable while file actions and diff reads stop.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`mountLoom()` mounts the Remote contribution, then registers under two inner fibers: one waiting for the slot services and `remote.loom` registers the dictionaries, the sources, the branching state, and the slot entries, and attaches the route list under a nested fiber that waits for `remote.session`; one waiting for `shortcuts` registers the tree's fixed reference rows. A failed registration disposes both fibers and withdraws the Remote. Disposing the plugin disposes the fibers, then withdraws the Remote. The view entry declares the tab store (the selected Session, collapsed rows, and the row holding the tab stop), so the framework keeps one per Session and the state survives switching tabs.

The entries read through three keyed sources bound as `useLoomFamily`, `useLoomReader`, and `useLoomRequest`:

- A family source subscribes to the client Session list while observed and derives the family with `forkFamily()` from `@deepseek-ai/dsh-experimental-loom/family`, from the list's `ids` and each row's `forkLineage` creation time. Unchanged nodes and families keep their references.
- A reader source retains its Session with the reference source `loom` while observed, follows the Session's Chat target, and folds the loaded turns: the opening user text, the closing assistant text and reasoning, the closing `assistant/message` seq, and the Turn tail's reasoning tokens and usage. Its last unsubscribe releases the Session.
- A request source calls `loom.requestAt` on its first subscriber and aborts a pending read when the last one leaves.

Three more keyed sources, bound as `useLoomCompare`, `useLoomDiff`, and `useLoomEstimate`, read one `loom` Remote value each: a key spells its request, and a source reads on its first subscriber, drops on its last unsubscribe, and reads again on request while it keeps showing its last value; a request made during a read queues exactly one more, and a source whose observer returns resumes a read that closing dropped. The generated Remote methods take no abort signal, so a result that arrives after a source closed is ignored. Adopt, apply, and discard are verbs of the plugin's workspace state; after an adoption it reads the adopted Session's projections again so that `loomBranch.adopted` reaches the tree.

Each source leaves its registry on its last unsubscribe, so nothing a reader stopped viewing stays in memory; the next observation of that key creates a fresh source that reads again. Failures name `session/not-found`, `loom/seq-out-of-range`, and `remote-access/denied`; other codes appear verbatim.

Fork facts come from the list's projection values: `forkLineage` for the cut, `sessionStats.fork` for own and inherited counts, `tokenUsage.fork` for own tokens, `turnOutline` for the inherited preview, `loomBranch` for a child's set and index, and `loomMark` for its mark. Each entry asks once per mount for the projections of a member that lacks them.

The branching state belongs to the UI fiber and is shared by every branching entry through the `loomBranching` hook: the sets the strip follows, one Branch ×N draft per dock, and marks being saved. `loom.branch` gets a fresh `requestId` per draft; after a carrier failure, whose outcome is unknown, a retry of the same draft reuses it so the Host creates nothing twice. The strip reads `loom.setStatus` when a set is first followed, again whenever one of its children starts, ends, or asks for approval while others are queued, and two seconds after each read while the set has queued children and none running or waiting for approval: the Host may then be forking the next child, and a fork that fails before the child has a Session changes nothing else the strip sees. A `loom.cancel` that withdrew fewer of the named children than the strip shows as queued also reads the set again. A set the Host no longer holds shows its queued children as not started. A set found running in the family after a reload is followed through `loom.setStatus`. A saved mark shows until the Session's projections are read again. Disposal drops this state and ignores results still in flight; branches keep running on the Host.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Loom interface Agent Note](../../../.agents/notes/implemented/feature/2026-10-18-loom-interface.md)
- [Chat conversation UI](../../client/ui-chat/README.md) — the inherited-span disclosure and the `conversation.chat.fork-cut` seat.

-----

<a id="model-experience"></a>
## Model Experience

None, as the browser plugin renders logged Session data and asks the `loom` service to start, adopt, apply, and discard branches, whose branch runner owns every prompt, route, and request a branch sends; applying a worktree change edits files the source Session can read later but adds no model input.

#### KV Cache effect

Each branch is a fork that inherits its parent's prefix, so its first request can reuse the family's cached prefix on routes that support prompt caching; a route override starts a new cache. Reading lists, histories, logged requests, comparisons, diffs, and estimates has no effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A family holds only Sessions in the client Session list, so a fork parent that is hidden or deleted roots the family at its highest listed ancestor.
- A sibling whose list row carries no `forkLineage` value sorts after its siblings until that value arrives.
- The view registry lists the Loom tab on every Session while the bundle is on, so every Session shows a tab strip.
- The reading pane is a read-only summary of the loaded turns, not the Chat transcript: tool calls and intermediate steps are omitted, and the reasoning shown is the closing step's. An embedded Chat would render a composer for the read Session and nest the current Session inside its own tab.
- Reading a Session other than the current one opens its history in the browser while the pane shows it.
- The tree shows own tokens rather than cost. The Regenerate panel and the Branch ×N form show an estimate that uses the selected route; a route without a configured price reads in tokens.
- The Workspace row cannot disable worktree isolation before the first request, because the Host reports no capability, and it does not say whether shared-folder children run one at a time, because the Host does not report its `concurrentWritableBranches` policy. The form and the panel always send their folder choice, so the Host's `defaultIsolation` applies only to requests that send none.
- A shared-folder branch's diff comes from the Host's per-turn change summaries, so a branch whose Session the Host does not hold live shows no diff, and siblings that wrote to one folder interleave in it. A worktree starts from the folder as it is when the branch starts, not as it was at the cut.
- Queued children of a set found running after a reload appear once `loom.setStatus` answers; a set whose children all wait or all ended is not found that way.
- The Keep and Set aside glyphs and the narrow-column threshold, measured against the Chat scroller rather than the message column, await designer review.
- The fork band appears only while the cut lies in Chat's loaded window; the header chip does not depend on the window.
- The zh copy awaits translator review.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
