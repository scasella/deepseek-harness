# Agent Note: Loom interface for branching Sessions and prose

Status: implemented

English | [中文](2026-10-18-loom-interface.zh.md)

## Problem

A Loom, after janus's Loom, treats model output as a tree: generate several continuations, inspect them, keep one, and retain the others. A dsh fork already copies an exact event prefix into a separate Session, but a flat list and linear conversation hide the relationship. Inherited work obscures a branch's own cost, repeated titles obscure its identity, and continuing a different answer or tool outcome requires rebuilding context by hand.

Branch exploration also multiplies model calls and filesystem activity. It needs explicit isolation, budgets, retained alternatives and input attribution rather than an interface that presents several answers without preserving how each was produced.

## Decision

Loom is an experimental, optional bundle, disabled by default. It provides the L1–L27 capabilities and a separate prose mode, Weave. Release packages own the reusable fork, conversation, search, loop and provider changes; experimental packages own Loom behavior and ignorable `plugin:loom/*` records. The [Loom README](../../../../packages/experimental/loom/README.md) owns configuration and Remote details.

| Owner | Responsibility |
|---|---|
| `experimental/loom` | Session branching, isolation, comparison, adoption, pricing, counterfactuals, prose records and downloads |
| `experimental/client-ui-loom` | Loom views, actions, Multiverse, mobile navigation, probabilities and localized feedback |
| `experimental/tool-loom` | The five budgeted autoloom tools |
| `experimental/loom-bundle` | Composition, isolated worktree provider and non-interactive child preset |

| Capability group | Scope |
|---|---|
| Orientation | L1 fork cut, L2 sibling pager, L8 tree and reader, L20 keyboard actions, L26 request inspection, L27 reasoning cards |
| Branching | L3 regeneration, L4 steering, L5 running strip, L11 route overrides, L13 edit-and-branch, L15 marks, L23 prompt variants |
| Outcomes | L6 comparison, L7 adopt/apply/archive, L12 worktrees, L24 autoloom, L25 list-price previews |
| Application shell | L9 Multiverse, L10 sidebar families and titles, L21 mobile layouts, L22 scoped search |
| Text and tools | L14 tool-result counterfactuals, L16 token probabilities, L17 prefix continuation, Weave, L18 curation, L19 export |

### Families and orientation

Loom branches are top-level fork Sessions created through `SessionController.fork`. `forkLineage` supplies the exact cut and list hints independently of the visible Chat window. Chat folds the whole inherited prefix, including a turn interrupted by the cut and its synthetic closers, behind a row with `conversation.chat.fork-cut`. The rows remain discoverable by browser search and focus, and rail navigation expands them. Header crumbs follow the full ancestor chain. Own/inherited usage and activity use the same cut; the own cache ratio and fork-mode subagent token metric exclude inherited work.

The browser derives visible families through shared `forkFamily()` logic; the Host provides the same read for callers without a Session list. Siblings sort by creation time, then Session id. Sidebar family adjacency takes precedence over individual pin and manual positions, without inheriting pin membership. Only roots are draggable, watermarks retain whole visible families, and a missing or hidden parent leaves its visible child as a root. Stable fork identity decorates the displayed title; it never enters rename drafts. Automatic fork titles use own eligible human prompts, while own manual renames stay pinned and inherited renames do not.

Multiverse uses explicit own/inherited scope and family Session ids; ordinary sidebar search keeps its default. Ownership is independent of current, shadowed or log-only classification, so a new replacement of inherited content is own work. Scan and SQLite providers filter ownership and ids before ranking and the result cap. The APG outline, written keyboard hints and shared BottomSheet make family and sibling actions available at phone width without hover.

Enabling the optional Loom bundle opts the existing Session-query provider into an in-memory index opened on first search, so Multiverse content search works in the shipped Web profile. Base and Web profiles without Loom retain their search-disabled default.

`requestAt` anchors to the latest settled request at or before the selected seq, including failed attempts. It reconstructs the loop-built request before provider projection, with bounded message previews and complete system text, rather than claiming to reproduce provider-specific serialization. The reading pane remains a summary of loaded turns; collapsed reasoning shows the closing answer step while its token count covers the turn.

### Branch admission and workspace ownership

Each branch set fixes an exact event cut when requested. Regenerate and edit repeat a human-opened turn; steering and variants keep the selected completed prefix. Editing changes text while retaining stored image/file references. Regenerating or editing a fork's first own turn creates siblings at its parent cut and defaults to the fork's actual own route, including an explicit selection not consumed by a header. If the parent is deleted, children fork the addressed Session instead. Redirecting to an existing parent requires access there in addition to the addressed Session. Explicit route overrides never save a global default; availability is validated per child by the Session Controller.

Admission is lazy and FIFO across sets, with concurrency and shared-folder writable gates. A folder-blocked child does not block eligible children behind it. Loom clears inherited next-turn input, records branch membership, applies Host preparation, then sends the indexed child prompt with durable initiator attribution. The ordinary Branch action retains its queued-input behavior. A slot lasts through whole-agent idle; additional prompts during a child's run extend it. Request identities deduplicate per addressed Session while retained. Teardown withdraws queued work and drains admissions; an existing set returns its cancelled children, while `gateway/cancelled` denotes no admitted set.

The running strip owns one entry per set id, including discovery during an in-flight start. It follows item changes and retries status reads for waiting idle sets that cannot emit Session changes; cancellation refreshes a set when fewer queued children were withdrawn than expected. Lines or positions identify children even before a Session exists. Branching keeps the source open except edit-and-branch, which opens its child; marks belong to a Session rather than a particular pager turn.

Worktree isolation requires the service, a Git repository and workspace-write policy. Loom and its provider share an isolated worktrees group so the separate Worktree bundle can coexist in either load order. The set captures HEAD plus uncommitted tracked changes at its first admission, excluding untracked files. Isolated children bypass the folder gate; repository mutations remain serialized. Git reads and mutations use the child's own execution policy, including when Compare resumes a cold child.

Compare derives tests from own command output through configured patterns, never presentation metadata, and combines diff facts, own usage, elapsed time, marks and adoption. Adopt records the chosen child, stops and archives siblings, never deletes Sessions, and reports partial archive progress for a safe retry. Apply writes an unstaged patch into a clean source checkout, refusing tracked dirt and conflicts; discard removes the isolated checkout. Both reserve the child's maintenance slot through removal and the isolation-end record, so waking prompts wait and other maintenance receives busy. Only Loom-owned worktrees are removed. An explicit ended-worktree fact stops stale diff reads and distinguishes removal from an unreadable diff.

### Pricing and autonomous exploration

No default prices ship. Validated provider/model rows price cache misses, cache hits and output; unknown usage or prices leave exact own USD absent. Each own settlement uses its logged route, including failed attempts. A Host-only token projection applies prices on read, keeping checkpoints independent of deployment prices. Branch estimates prefer the repeated turn and otherwise average visible family own turns. Unpriced estimates report tokens; missing evidence yields no ranges. All dollar figures are list price.

Weave estimates use reported own prose input on the selected logged provider/model, preferring the latest exact joined-prefix match and otherwise disclosing a historical different-prefix basis. They average siblings that reported usage and price the full requested output cap at both cache-price endpoints. They never guess tokens from characters, treat absent history as zero cost, or dispatch a provider call. Probes and inherited requests provide no basis.

Autoloom uses the same runner through Host-only `branchFor`, so browsers cannot forge its prompt source or preparation. Its five tools operate only on a weaver's own sets and children. Expansion checks branch, depth, own-token and optional USD budgets before creating a fork; a USD limit requires priced usage and an estimate. Each child receives its non-interactive permission preset before its first prompt and logs the `loom` source. Children cannot create independent runs. Settlement watchers stop running children with hook causes and withdraw queued work when a budget is exhausted or usage becomes unpriced. Unloading aborts reads, wakes waits, stops owned work and drains admissions and activity before removing watchers and state; completed Sessions remain usable.

### Continuation and tool-result counterfactuals

An idle Agent can continue existing model history without a new user message only when both inbox queues are empty, all retained tool calls are answered, and the last conversational message is user or tool. Maintenance, assistant tails and pending tools refuse admission without changing the log. `turn/start.continuation` records the existing `MessageSource`, including Remote request identity and non-owner initiator. Accepted continuation retains its marker even if an observer immediately cancels it; own request identities deduplicate retries after resume, while inherited identities do not suppress a fork's work. Both SDK readers preserve the optional marker without adding a separate SDK runtime verb.

Counterfactual editing forks after the selected completed tool-result batch, clears inherited pending input, and writes an override record plus a content-only replacement inside the first continuation pre-step, after turn/start and before model derivation. This preserves companion results and released reader lifecycle rules. Chat updates the existing tool row while retaining call identity, arguments, timing, metadata and success/error classification. Incomplete batches refuse before a fork; failures after creation name the retained child, and the client offers that child instead of blindly creating another.

### Recorded probabilities and prose

Token capture is opt-in per route. `BlockTokenLogprobs` is optional metadata on the existing block-end chunk, and the request header records the requested capture count. No chunk discriminator or model-facing content block is added. pi-ai pairs raw provider events with text deltas for that request and publishes capture only when the complete token text exactly reproduces the answer block. Missing or malformed metadata, including byte-split text that cannot reconstruct it, omits capture and reports degradation. Thinking blocks receive none. Null sampled probabilities remain unknown, and unknown alternatives are omitted; the UI never fabricates a probability or rescoring call.

Assistant-prefix continuation is a separately declared tool-free auxiliary capability, refused for loop calls, tools, tool history, empty prefixes or reasoning that is not off. The exact prefix survives provider serialization or the call fails before I/O. Weave records resolved route, controls, framing, messages and authored prefix spans before dispatch, followed by each sibling's complete stream. It holds the Session maintenance slot, aborts and drains on unload, and stops sibling dispatch if a settlement cannot be recorded. Cold prefixes use lead-then-burst; warm hints change scheduling only, never promise cache hits. Replay orders auxiliary nodes by request seq and sibling index rather than completion time. New fork Sessions bind replay roles by creation order; stored and seeded children retain first-call binding.

Weave text stays outside Chat. Persisted nodes retain their exact prefix spans, and choices reconstruct the selected document after reload. User edits preserve the unchanged prefix's attribution and mark the edited suffix as human text. Captured alternatives cite the source node and token index; partial tokens lose capture rather than claim an exact match. Preview is not a choice. Every recorded request, including unchosen and ancestor sets, stays selectable, and each model block can reopen its siblings. Per-Session client state retains unsubmitted prose, cursor, route and controls across view remounts; it is a draft, not another durable document.

Probes explore recorded one-token alternatives within depth, cumulative-probability and request limits. Recorded sampled positions distinguish an unprobed location from a sampled position with no retained alternative. The diagram nests cumulative-probability areas beneath their parents and provides a full-size written path selector. Its residual means unshown mass, including alternatives outside the returned top tokens; blank space does not mean zero probability. Probability display uses written values and non-color cues, separately from normal Markdown answers and reasoning.

Curation sums log2 of completed sibling counts over current Weave choices only; repeating a choice is idempotent, replacing it replaces that set's credit, and choice order follows the latest selection. Session marks, adoption and probes add no credit. Export supports a path, its siblings or kept branches with source and curation facts in JSON, text or escaped HTML. Downloads are immutable owner-only Connection snapshots bounded by bytes, count and lifetime. Teardown aborts and drains pending exports before releasing the route; a late result cannot create a dead download URL.

## Alternatives considered

**Alternate assistant messages inside one Session.** `assistant/message` cannot replace the surface. Separate fork Sessions preserve every continuation using the existing storage and lifecycle.

**Subagents, workflows or Agent Teams as branches.** Their hidden child Sessions seed from the caller's own completed history. Loom needs top-level branches at an exact event cut, with independent navigation and retention.

**Prefill inside the agent loop.** DeepSeek refuses prefix completion with tools or tool history, while ordinary loop requests carry preset tools. An auxiliary request with exactly logged inputs avoids an unsupported loop operation and keeps prose separate from Chat.

**A new probability chunk variant or declared Loom events.** Exhaustive stream readers and replay reject new chunk variants; required-on-read events make old Session readers refuse a log. Optional block-end metadata and ignorable experimental records preserve reader compatibility without changing existing discriminators.

**A canvas graph dependency.** Fork lineage has one parent per node. An APG outline provides keyboard and screen-reader navigation without a graph renderer; the probability diagram retains written controls for regions too small to operate directly.

## Consequences

- The bundle keeps Loom-specific controls optional. Release behavior still includes inherited Chat folding and its cut seat, full fork crumbs, own/inherited counters, sidebar families and titles, scoped-search support, provider corrections and opt-in probability capture. The inherited fold affects every Branch user and needs product sign-off.

- Branch sets and autoloom budgets live in Host memory. Restart loses queued admissions, status/cancel handles and retry deduplication, but keeps started Sessions and records. `retainedBranchSets` defaults to 256 finished sets, evicts oldest creation first and never drops active work; eviction expires its request identity without deleting a Session or worktree. Reusing that identity creates another set.

- Family cache affinity uses a separate root `cacheSessionId`, leaving real Session ids for replay, attribution and lookup. Compaction, title calls and fork-mode subagent requests still key by their own Session. Subagents root separate families; shared cache affinity does not guarantee a provider hit.

- Shared-folder gating covers admitted Loom children, not the source, unrelated Sessions or later work. Concurrent shared writers can observe or misattribute each other's edits. Worktree bases capture first-admission state, not request-time state, omit untracked/ignored files, do not install dependencies, and require a commit. Adoption/archive keeps worktrees until apply/discard; apply is a patch, not a merge, and carried uncommitted tracked work must be committed before applying.

- Autoloom checks before expansion and reacts to settled usage, so a final response can exceed a token or dollar budget. Its schemas add request tokens wherever the plugin is mounted. Regenerated stored file-reference rebinding remains a named real-persistence verification gap. Public selection resolution and an upfront isolation-availability/policy read remain deferred; unavailable route/isolation feedback is per child or typed refusal.

- Exact probability alignment deliberately loses capture for unsupported or byte-split token text. Probe results are bounded top-token samples, not a complete model distribution. Weave warm hints, unsubmitted browser drafts and download URLs are transient; persisted nodes, exact prefixes and choices survive reload. Continuing woven text directly into Chat remains outside scope.

- Request inspection folds the complete log and returns complete system text without paging. The reader is a loaded-turn summary. Cold worktree comparison can activate a Session; shared diffs depend on live Host summaries, and unmatched test summaries report no result. Missing visible ancestors re-root a family instead of revealing hidden Sessions.

- Experimental records are retained best-effort across Session migrations. Malformed ignorable prose records supply no document state or curation credit. Telemetry retains record envelopes but redacts Loom payloads. Optional continuation and probability fields use same-version persistence acknowledgements and reader evidence; existing replay scenarios remain unchanged when capture and continuation are absent.

- Regression coverage combines per-file unit coverage, real Loader compositions, persisted/cold reads, authored Session and SDK projections, keyless Web ARIA and geometry checks, and OpenRouter-gated API/browser flows. Live runs use isolated homes and repositories, verify decoded logs and disk state, and measure key usage before/after each run against the approved $5 total.

- Designer approval of the bundle artwork and new glyphs, translator review of Chinese copy, a decision on an OpenRouter CI secret, and a real-server PR GIF remain people-dependent integration requirements. The inherited fold also needs product sign-off. These block merging to master, not implementation on the feature branch.
