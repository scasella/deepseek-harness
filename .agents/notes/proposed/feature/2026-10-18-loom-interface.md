# Agent Note: Loom interface for branching Sessions and prose

Status: proposed

English | [中文](2026-10-18-loom-interface.zh.md)

## Problem

A Loom (after janus's Loom) treats model output as a tree: generate several continuations, read them, keep one, and never lose the others. dsh already stores that tree, because a fork is a Session that copies an exact event prefix and records its `parentSession` ([fork.ts](../../../../packages/core/session/src/fork.ts)). The product does not show or use it:

- Forks appear as flat sidebar rows. Every fork made with Branch is renamed "… (1)", so five siblings are indistinguishable and the root can scroll under "Show N more sessions".
- A fork opens with no mark at the cut, and its footer counts the inherited turns as its own.
- Committed turns have no regenerate, no edit-and-branch, and no sibling navigation.
- There is no way to branch N ways at a decision point, compare the outcomes, and adopt one.
- Token probabilities are never captured, so dsh cannot show where the model was uncertain or continue from a chosen token.

The design round that motivates this note drew ten screens in the live Web app over real forks and real token probabilities, and catalogued 27 proposals, L1–L27. This note is the staged plan to build them.

## Proposal

### Shape of the work

Loom behaviour lives in new experimental packages, with small owner changes in release packages where a seat, a projection or a request field is missing:

| Package | Face | Owns |
|---|---|---|
| `packages/experimental/loom` | Host service and `loom` Remote (template: `api-speech-to-text`) | `plugin:loom/*` records, the `loomBranch` projection unit, the branch runner, worktree glue, compare, adopt and apply, `requestAt`, export route, Weave, pricing `Config`, telemetry redaction |
| `packages/experimental/client-ui-loom` | Client plugin | Every Loom slot entry, the Loom view tab, the multiverse page, strips, pager, forms, token shading, tree keys, locale namespace `loom` |
| `packages/experimental/tool-loom` | Host model tools | `loom_expand`, `loom_wait`, `loom_read`, `loom_cull`, `loom_keep` for autoloom (L24) |
| `packages/experimental/loom-bundle` | Optional bundle | Inserts the three packages (and `worktree` for L12); an `OPTIONAL_BUNDLES` entry |

A Loom branch is always a top-level fork Session created through `SessionController.fork`, never a hidden subagent. The branch runner forks lazily: it creates a child only when a concurrency slot admits it, removes inherited next-turn inbox items so a prompt queued in the parent cannot run first, writes a `plugin:loom/branch` record, and sends the child's prompt with a `user-rpc` source. No empty forks are left behind when a page closes.

### Decisions on open questions

- **Fork route (L11).** Forks already continue on the parent's logged route: `session-fork.host.spec.ts` asserts it, and a live check on 2026-10-18 confirmed it with a different default model. L11 shrinks to an explicit per-branch route override through `selectForNextRequest`, which never saves the global default, plus the parent's turn-1 route for a cut before the first request.
- **Inherited queued prompts.** Only Loom drops them. The product's Branch button keeps its behaviour; changing it would need an upgrade guide and is outside this plan.
- **Weave.** A prose mode whose document lives in `plugin:loom/weave-*` records. Woven text does not enter the Chat surface. A "continue in chat" action is out of scope.
- **Curation meter (L18).** Counts Weave choices only, as Σ log2 n per choice. Adopt decisions are recorded but not counted.
- **Scoped search (L22).** The sidebar search default stays as it is; Loom passes an explicit scope.
- **Shipping.** Loom ships as an optional bundle that is off by default; the plugin manager holds it under More until it is switched on. A `--patch` overlay for development lands in S1 with the first visible slot and its overlay-equality Web test.
- **Promotion.** Loom records stay experimental plugin records. Promoting them to `SessionEventMap` members would make them required-on-read, so it waits until the design settles.
- **Fork footer split (F3).** Forked closers count as inherited work. The usage pill shows the own total and the own cache hit, in Compact too, then the inherited total; its dialog lists the own buckets and one Inherited row. Both halves of the activity pill use the unforked counts wording. A fork-mode subagent child's header token metric counts only its own requests.
- **Family reads (F4–F5).** The browser derives fork families from its client Session list with the shared `forkFamily()` export, and siblings are ordered by `forkLineage.createdAt`, then by Session id. The Host `loom.family` Remote serves callers without a Session list. Branch admission limits become `Config` fields in S2, with the branch runner that enforces them.
- **Fork-mode subagent golden.** A keyless Web golden for a fork-mode subagent child's header token metric and composer dock lands in S1, which changes the same header with fork crumbs; S0 covers the change with ui-subagent and ui-chat client specs.

### Stages

Each stage lands as one or more commits on `loom/loom-interface`. A stage is done when typecheck, focused tests with per-file coverage, `build:check`, the relevant `doc-sync` gates and the stage's live suite pass, and the spend ledger is updated.

**S0 Foundations.**
- F1: `completedPrefixBefore(events, turn)` in session-controller, including the turn-1 cut (the last standalone event before the first prompt splice). Fix the stale fork docs ([architecture.md](../../../../docs/architecture.md) `seedLength`, `docs/subsystems/session.md`).
- F2: a release `forkLineage` projection (`parentSession`, cut seq, cut turn, `createdAt`) that the sidebar and Loom can read from list hints.
- F3: own and inherited buckets in the `tokenUsage` and `sessionStats` projections, with `stateVersion` bumps, and the footer pills that read them.
- F4–F6: the `loom` and `client-ui-loom` skeletons, `loom-bundle`, and every shared registration (tsconfig paths, faces, bundle rows, CLI and Web dependencies), written by one agent.
- F7: `llm-replay` binds children created after its installation by creation order instead of first call; stored and seeded children keep first-call binding.
- F8: Web scaffold seeding for fork families (`parentSession`, `isSeeded`, inherited `session/end-seed`).
- F9: pi-ai route fixes: map `usage.reasoning`, pass `stop` through `samplingParams`, provider pinning through the route profile's `openRouterProvider` field, and a working "thinking off" mapping.
- Toolchain probes: `persistence-changes --record` and the Python SDK snapshot refresh on this machine.

**S1 Orientation (reads only).** L1 fork band, the inherited span collapsed in Chat, fork crumbs in the header, and own/inherited footer counts; L8 Loom tab with an outline tree and reading pane; L26 "what the model saw" as a `loom.requestAt` Remote; L20 tree keys; L27 reasoning collapsed on sibling cards with its token count.

**S2 Branching.** L3 regenerate ×N; L4 N-way branch with a steering line per child; L5 running-branches strip; L11 route override; L2 sibling pager (needs a wider `AssistantActionOwnerProps` and a seat after Branch in ui-chat); L13 edit an earlier user message and branch (new `conversation.chat.user-actions` seat); L15 private marks with a telemetry redaction listener; L23 prompt-variant sets.

**S3 Workspace and money.** L12 worktree isolation per branch; L6 outcome-first compare (tests parsed from the branch's own command output with configurable patterns, diff stats from git, own cost and time); L7 adopt, apply and archive; L25 cost preview from a validated pricing `Config`; L24 autoloom in `tool-loom`.

**S4 Shell.** L10 sidebar fork families with fork-aware titles (session-title and ui-workspace owner changes; upgrade guide); L9 multiverse page; L22 search scoped to own, inherited or sibling history (session-query and controller); L21 mobile layouts with a bottom-sheet primitive in ui-primitives.

**S5 Loop entry.** F10: an agent-loop `continue` entry that runs a step without a new user message, with a `turn/start.continuation?` marker, a controller RPC, the architecture docs and both SDK expected outputs. Then L14: edit a recorded tool result (a content-only surface replacement, which the session already admits) and continue.

**S6 Tokens and prose.** L16 per-token logprobs as an optional `logprobs` field on the `block-end` stream chunk, captured on the pi-ai route; L17 continue from an assistant prefix on tool-free auxiliary calls only; Weave with lead-then-burst scheduling and the block multiverse view; L18 curation meter; L19 export of a path, path and siblings, or kept branches, with the curation record.

### Live tests

The regression guard has two layers:

- **Keyless, in CI.** Unit specs at 100% per file, authored or replayed session snapshots, and Web ARIA goldens with `DSH_SNAPSHOT=replay`. These cost nothing.
- **Live, local.** Real-API suites gated on `OPENROUTER_DEEPSEEK_API_KEY` that self-skip when it is empty, run as `DEEPSEEK_API_KEY= pnpm run test:e2e <files>` because the unfunded `DEEPSEEK_API_KEY` in `.env` would otherwise make DeepSeek-gated suites run and fail. The test overlay uses the plain model id `deepseek/deepseek-v4.1-flash-1017` with provider pinning, never an account preset, so no account-specific id reaches a fixture. Live browser runs use an isolated `DSH_HOME`, a port other than 3080, and `--patch apps/web/tests/pin-browse-picker.overlay.yml`.

Each stage adds live cases for what it changed: S0 verifies fork routing (`fork-route.e2e.ts` in session-controller). Cache reuse across forks is open: on the OpenRouter route pi-ai sends each Session's own id as the `x-session-id` affinity header, and a probe on 2026-10-18 read 1,536 cached tokens for a repeated request under the same id and none under another id. S2 regenerates and branches for real and checks child routes, prompts and `cacheReadTokens > 0`, which needs one affinity key per fork family; S3 isolates two branches that write the same file differently; S5 continues after an edited tool result; S6 checks content logprobs, the absence of reasoning logprobs in thinking mode, a mid-sentence continuation, and the refusal with tool history.

## Alternatives considered

**Alternate assistant messages inside one Session.** The surface cannot hold them: `assistant/message` can never be a replacing surface event. Siblings as separate fork Sessions reuse the storage dsh already has.

**Subagents, workflows or Agent Teams for branches.** Their children are hidden `origin: subagent` rows seeded only from the caller's own last turn end. A Loom branch needs a cut at an exact seq of another Session.

**Prefill inside the agent loop.** DeepSeek rejects prefix completion whenever the request has tools or tool history, and every loop request carries the preset's tools. Prefill is limited to auxiliary calls whose exact request is logged first.

**A new stream chunk variant for logprobs.** Readers use exhaustive switches over chunk types and llm-replay whitelists them, so a new variant breaks at run time. An optional field on `block-end` is ignored by released readers.

**Declared `loom/*` session events.** No API appends a declared event as ignorable, so older readers would refuse logs that carry them. Experimental plugin records are ignorable and travel with forks.

**A canvas graph library for the tree.** A lineage is a tree with one parent per node; an APG outline tree (the `SubagentHeaderLineage` pattern) serves keyboard, screen readers and phones without a new dependency.

## Acceptance criteria

- Every L1–L27 proposal and Weave is reachable in the Web app when the Loom bundle is enabled, and nothing changes when it is disabled, except the owner changes in release packages listed above (fork families in the sidebar, fork crumbs, own/inherited footer counts, own-only fork-mode subagent header tokens, the pi-ai `stop`, thinking-off and reasoning-count mapping, the `forkLineage` projection, scoped search parameter, logprob capture).
- Each stage's keyless specs, snapshots and Web goldens pass in CI, and its live suite passes locally under the $5 ledger approved for this work.
- No new `as unknown` casts, no growth in the no-unknown-casts baseline, 100% per-file coverage for new and gated files, and passing `doc-sync`.
- Persistence acknowledgements exist for `block-end.logprobs` and `turn/start.continuation?`; TypeScript and Python SDK expected outputs are refreshed for F10.

## Risks

- **Spend.** Regenerate ×N, variants and autoloom multiply calls. S2 adds `maxBranchesPerRequest` and `maxConcurrentBranches`, and S3 the autoloom budgets, as validated `Config` fields, and cost previews always say "list price".
- **Shared folders.** Without L12, concurrent writing branches race on one folder. The runner refuses concurrent write-capable branches without isolation unless the user chooses one-at-a-time.
- **Telemetry.** Feedback-triggered exports include plugin records and logprobs; Loom mounts a redaction listener.
- **Record durability.** Experimental records are kept only best-effort across format migrations; the README says so.
- **Needs people.** Designer approval for the bundle icon and the new glyphs (keep, set aside, multiverse, weave, bottom sheet); translator review of zh copy; a decision on an OpenRouter secret in CI (until then the live suites stay local). These block merging to master, not the branch work.
