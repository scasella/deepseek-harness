# Explore alternatives with Loom

English | [中文](loom.zh.md)

## Summary

Loom keeps model output as a tree: generate alternatives, compare them, choose a direction, and retain the other histories. Use Chat branches for agent tasks and Weave for prose at a cursor. The optional experimental bundle adds a Loom conversation tab, a Multiverse page, and budgeted tools for model-driven exploration.

## Table of Contents

- [Enable Loom](#enable-loom)
- [Create and read branches](#branches)
- [Compare and apply changes](#compare)
- [Try a different tool result](#tool-result)
- [Write prose with Weave](#weave)
- [Let a model explore](#autoloom)
- [Costs, saved data, and limits](#limits)
- [Further Exploration](#further-exploration)

<a id="enable-loom"></a>
## Enable Loom

Use a Harness build that includes Loom and its matching core changes, with a [configured model](providers.md) and a selected [workspace](index.md). The published `0.2.1-rc.2` runtime predates these APIs; installing the Loom package into that runtime is not supported. Until the coordinated release is published, use the source checkout containing this feature.

Open **Plugins**, select **More** beside **Experimental plugins**, and switch on **Loom**. Open a conversation and select **Loom** beside Chat. The tab provides Read, Compare, and Weave; **Multiverse** appears in the sidebar. Loom is off by default.

For file-editing comparisons, use a Git repository with at least one commit and give the Session workspace-write permission. Prose needs a route that declares tool-free assistant-prefix support; token exploration additionally needs reported token probabilities. A refusal names the unsupported capability so you can choose another route or reduce the requested alternatives.

<a id="branches"></a>
## Create and read branches

After a completed Chat turn, use these actions to explore without replacing the original conversation:

| Action | What it changes |
|---|---|
| **Regenerate** / **Regenerate ×N** | Repeats the opening prompt in one or several new Sessions. |
| **Branch ×N** | Starts a continuation for each steering line; Samples per line adds repeated variants. |
| **Edit & branch** | Replaces a user prompt in a new branch, retaining its stored attachments. |
| **Model → Change** | Overrides the model and thinking setting for these children only. |

The running strip follows active and queued branches. Cancel withdraws a queued child before it creates a Session. Keep and Set aside are private curation marks, independent of feedback ratings. The variant pager and header chip switch between siblings at the same cut.

In **Loom → Read**, select a tree row to read that branch. Inherited turns start folded; expand them to see the shared prefix. Own turns and own token counts distinguish new work from inherited work. **What the model saw** shows the logged request before provider-specific serialization, and a reasoning card opens recorded reasoning when available.

Focus the tree to use Up/Down, Left/Right, Home/End, and Enter. Press `g` to branch, `k` to keep, and `x` to set aside. The shortcut reference lists these keys. At phone width, the variant chip opens a bottom sheet with full titles and visible controls.

Use **Multiverse** to browse fork families across Sessions and search Own messages, Inherited messages, or All history. The sidebar nests branches under their source; its ordinary search keeps its existing scope.

<a id="compare"></a>
## Compare and apply changes

Choose **Isolate each branch in a worktree** before starting competing file edits. Each child receives HEAD plus uncommitted changes to tracked files at the set's first admission. Untracked and ignored files are excluded, and dependencies are not installed. Shared-folder branches see the same files; serial admission does not isolate them from the source or later prompts.

Open **Compare**, choose a branch point, and select a row. Compare shows test summaries parsed from that branch's own command output, diff statistics, own usage, wall time, and marks. Missing test summaries mean no configured pattern matched; they do not mean the tests passed. Expand a row to inspect each file diff.

- **Apply diff to folder** copies an isolated branch's patch into a clean source checkout and removes that worktree. It refuses tracked source changes or conflicting patches; first commit or stash source changes, then inspect and retry. The applied changes remain uncommitted.
- **Adopt** records the chosen branch, stops running siblings, and archives them. It retains every Session history and does not apply files or remove worktrees.
- **Discard worktree** removes only the isolated checkout Loom created; its Session history remains readable. **Continue here** opens the selected branch in Chat.

<a id="tool-result"></a>
## Try a different tool result

On a settled tool result, choose **Edit result & branch**, edit the visible result text, and continue. Loom creates a fork and lets the model respond to the replacement without rerunning the tool or adding a user message. The source result, tool arguments, companion results, timing, and success/error classification remain intact. The replacement is a hypothetical observation; continuing can make further tool calls under the child's permissions.

<a id="weave"></a>
## Write prose with Weave

Open **Loom → Weave**, write an opening, place the cursor, choose a local model and controls, and generate several continuations. These calls use the exact text prefix with no Chat history or tools, and thinking is off. Preview candidates without changing the document; Choose records one and retains all siblings. The retained-request selector reopens earlier sets.

Recorded answer probabilities use shading, dotted underlines, and written percentages. Open a token to inspect alternatives or explore a bounded token multiverse, then continue from a selected token. Uncaptured text and reasoning have no probability annotation. The explorer labels unshown probability mass only at positions it actually probed.

The curation meter sums `log₂(N)` for each current choice among N completed Weave siblings. Replacing a choice replaces its credit; Chat marks and probe paths add none. Export the current path, its siblings, or kept prose nodes as HTML, text, or JSON. Review exports before sharing: they retain generated and authored text, attribution, and curation records. Text and HTML include the full JSON record.

<a id="autoloom"></a>
## Let a model explore

Ask a model to explore two continuations, read both, keep one, and archive the other. The five tools are `loom_expand`, `loom_wait`, `loom_read`, `loom_keep`, and `loom_cull`. Their cards link real child Sessions and show remaining budgets. The bundle gives children the read-only, non-interactive `loom-child` permission preset; children cannot start independent exploration runs.

Configure branch, depth, own-token, and optional list-price dollar budgets before autonomous work. Expansion refuses an exceeded budget before creating a fork; settled usage can overshoot a token or dollar limit by the last response. A dollar ceiling requires configured prices and a priced estimate.

<a id="limits"></a>
## Costs, saved data, and limits

Each branch runs its own model requests. Each prose continuation makes an auxiliary call; token probes make additional bounded calls. No prices ship by default. Without configured provider/model prices, the UI shows tokens, not zero dollars. Configured dollar figures are list-price estimates, not an account balance or invoice. Shared-prefix scheduling can improve cache reuse but does not guarantee a cache hit.

Session histories, recorded prose nodes, and choices persist. Branch queues, retained set status, autonomous budgets, warm-prefix hints, and download URLs live in Host memory: restarting loses them, and queued children do not resume. Started children remain available. Adopting or archiving does not clean up a worktree; use Apply or Discard explicitly.

Loom is experimental. Its plugin records, APIs, and UI have no stability promise; Session format migration retains experimental records only on a best-effort basis. Export material you intend to keep or share, and retain normal workspace backups.

<a id="further-exploration"></a>
## Further Exploration

- [Loom bundle](../../../packages/experimental/loom-bundle/README.md) — composition and profile configuration.
- [Loom service](../../../packages/experimental/loom/README.md) — isolation, pricing, limits, and Remote behavior.
- [Autoloom tools](../../../packages/experimental/tool-loom/README.md) — child permissions and budget configuration.

## Dev Note

None.
