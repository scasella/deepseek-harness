# Loom

[English](loom.md) | 中文

实验性 [Loom 服务](../../packages/experimental/loom/README.zh.md)把 fork 出的 Session 视为一棵树。fork Session 复制其源会话的一段精确事件前缀，并把源记录为父会话；Loom 读取这棵树，通过 Session Controller 的 fork 创建分支子会话（可选地各自位于自己的 Git worktree 中），比较并采用它们，并以实验性插件记录添加分支归属、隔离、采用与私有标记。[Loom 界面 Agent Note](../../.agents/notes/implemented/feature/2026-10-18-loom-interface.zh.md) 负责分阶段计划。

## fork 家族

`LoomFamily` 是从 Session 列表推导出的一个 Session 的 fork 家族：`rootId` 指向列表中可见的最高 fork 祖先，`focusId` 指向所请求的 Session，`nodes` 按深度优先顺序包含根的全部可见 fork 后代，兄弟节点先按创建顺序、再按 Session id 排列。`LoomFamilyNode` 携带文本为 Session id 的品牌化 `LoomNodeId`、Session id 本身、父节点、深度、该行 `forkLineage` 列表提示存在时给出的创建时间，以及列表状态 `updatedAt`、`running` 与 `blank`。subagent 的父链接不是 fork 链接。浏览器通过 `@deepseek-ai/dsh-experimental-loom/family` 导出从客户端 Session 列表推导家族；Host 的 `family()` 读取服务其他调用方，`LoomFamilyRequest` 指定家族中的任一成员。

## 分支集合

`LoomBranchRequest` 是四种请求之一，每种都指定源 `sessionId`、用于重试的品牌化 `LoomBranchRequestId` 以及可选的 `ModelSelection` 路由：`LoomRegenerateRequest` 与 `LoomEditRequest` 在打开某个 turn 的提示之前切分并重新发送该提示（原样或替换文本），但对于 fork Session 自己开始的首个 turn，它们在该 fork 的切点处 fork 其父会话，除非请求指定路由，否则沿用该 fork 的路由，使子会话成为该 fork 旁边的更多变体，若该父会话已不存在，则在该 fork 自身中切分，位于其下方；`LoomSteerRequest` 与 `LoomVariantsRequest` 在某个 turn 结束处切分并发送每一行，variants 对每个样本各发送一次。运行器只在并发槽位准入子会话时才 fork 它，移除子会话从切点继承的下一 turn 提示，写入子会话的分支记录，然后发送其提示。`LoomBranchValue` 列出每个 `LoomBranchChild`：带 Session 的 `started`、尚无 Session 的 `queued`、带 RemoteError 代码与消息的 `failed`，或在调用期间服务卸载并将其撤回时的 `cancelled`。`LoomSetStatus` 读取同一份 Host 内存中某个 `LoomSetId` 的状态，被 `LoomCancelRequest` 撤回的排队子会话同样报告为 `cancelled`；这份内存不会在 Host 重启后保留，因此重启前的集合报告 `loom/set-not-found`。

## worktree 隔离

`LoomIsolation` 选择分支子会话存放文件的位置：`shared` 使用源 Session 的文件夹，`worktree` 为每个子会话创建一个 [Git 工作树](worktrees.zh.md)，同一集合使用同一个基准提交，即源文件夹的 HEAD 加上其未提交的已跟踪变更。`LoomBranchRequestBase.isolation` 按请求指定它，默认取 Loom `Config` 的 `defaultIsolation`。Host 无法隔离的请求在任何 fork 之前以 `loom/isolation-unavailable` 失败，其 `LoomIsolationUnavailableReason` 为 `service-unavailable`、`read-only`、`no-repository`、`subdirectory` 或 `linked-checkout`。worktree 子会话不受“每个文件夹一个写入者”规则限制。

## 比较与 diff

`LoomCompareRequest` 指定一个 fork（其切点选出兄弟会话），或者一个集合及其任一成员或其源。`LoomCompareValue` 包含父会话、切点，以及每个可访问兄弟会话的一个 `LoomCompareRow`，内容读取自该兄弟会话的自身日志：标题与首个自身提示、`LoomBranchKind` 或 `fork`、隔离方式、是否在运行、来自自身命令输出的 `LoomCompareTests`、来自 Git 或自身各 turn 变更摘要的 `LoomCompareDiff`、`LoomCompareOwn` 步数与 token、墙钟时间、标记，以及是否已被采用。`LoomTestSummaryPattern` 与 `LoomCommandTool` 配置测试结果的读取。`LoomDiffRequest` 返回 `LoomDiffValue`，其中包含一个分支或其某个文件的统一 diff，以及是否省略了文件。

## 采用、应用与丢弃

`LoomAdoptRequest` 采用一个 fork：向其写入 `plugin:loom/adopt`，并通过 Workspace 注册表归档其兄弟会话（其集合中的其他成员，或其切点处的其他 fork）；`LoomAdoptValue` 列出它们。`LoomApplyRequest` 用 `git apply` 把空闲 worktree 子会话的变更复制到源文件夹并移除该 worktree；`LoomApplyValue` 列出写入的路径，`loom/apply-dirty`、`loom/apply-conflict`、`loom/apply-too-large` 与 `loom/apply-not-isolated` 会在任何写入之前拒绝它。`LoomDiscardRequest` 移除该 worktree，并以 `LoomDiscardValue` 返回其路径与分支。应用与丢弃只触及子会话隔离记录所指明的 worktree。

## 分支归属与标记

`plugin:loom/branch` 是分支子会话在首次提示前持有的 `LoomBranchRecord`：`LoomSetId`、源 Session 与包含在内的切点 seq、`LoomBranchKind`、子会话按请求顺序从 0 开始的 `index`，以及 variants 子会话所属行的 `variantKey` 摘要。`loomBranch` 投影发布 `{ setId, kind, index, variantKey?, createdAt }` 形式的 `LoomBranchView`，不是 Loom 分支子会话的 Session 为 null。`plugin:loom/mark` 是持有 `LoomMark`（`keep` 或 `set-aside`，或用 null 清除）的 `LoomMarkRecord`；`loomMark` 投影把最后一条发布为 `LoomMarkView`，或为 null。`plugin:loom/isolation` 是指明 worktree 子会话的基准提交、worktree 路径、分支与仓库根的 `LoomIsolationRecord`；`plugin:loom/isolation-end` 是 Loom 应用或丢弃该 worktree 时写入的 `LoomIsolationEndRecord`；`plugin:loom/adopt` 是 `LoomAdoptRecord`，其后 `LoomBranchView` 带有 `adopted: true`。只有位于 Session 继承事件数之后（含）的记录才计入，因此分支或已标记 Session 的 fork 两者皆无。标记从不是反馈事件，遥测导出会移除每条 `plugin:loom/*` 记录的载荷。

## 模型看到的内容

`LoomRequestAtRequest` 指定一个 Session 与任一事件 seq。`LoomRequestView` 描述 settlement（`assistant/message` 或 `assistant/attempt`）位于该 seq 或之前的最新一次模型请求，并按 agent loop 的推导方式从完整日志重建：来自当时生效的 `request/header` 的 `LoomRequestRoute` 与工具名，记录该请求所在 turn 中 `developer/message` 事件所增删工具的 `LoomRequestTools`，包含生效系统提示及其在首个提示之后变化时写入它的 turn 的 `LoomRequestSystemPrompt`，以及每条请求消息对应的一个 `LoomRequestMessage`，带有产生它的 seq、角色、继承标记、有界预览与长度。`inheritedTurns` 与 `ownTurns` 以 fork 切点划分请求之前开始的 turn。该视图是 loop 构建、尚未经提供方路由投影的请求，因此不支持工具更新的路由不会收到 developer 行。不在日志中或早于首个 settlement 的 seq 以 `loom/seq-out-of-range` 失败。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxloom--loom"></a>

### `ctx.loom` — `Loom`

Loom Host service. It registers the `loomBranch` and `loomMark` projection units, the telemetry redaction rule for `plugin:loom/*` records, the branch runner, and the compare, diff, adopt, apply, and discard operations for its own lifetime, and exposes the `loom` Remote namespace.

```ts cordis-catalog
/**
 * Read the fork family of one visible Session from the current Session list
 * without activating any Agent. The Gateway authorizes the addressed Session
 * through the `sessionId` field the Session Controller registers as the
 * `session` resource, and the result keeps only Sessions the caller may list.
 * It serves callers without a Session list of their own; the Loom browser
 * plugin derives families from its client Session list instead.
 * @param request - any member of the family.
 * @param signal - cancellation for the list read.
 * @returns the visible family rooted at the highest visible fork ancestor.
 * @throws RemoteError `session/not-found` when the caller cannot list the Session.
 */
@Remote async family(request: LoomFamilyRequest, signal: AbortSignal): Promise<LoomFamily>

/**
 * Rebuild the model request in force at one event of a Session from its
 * whole log, without activating its Agent: the latest request whose
 * `assistant/message` or `assistant/attempt` settlement is at or before
 * `seq`, with its route, tools, effective system prompt, and messages split
 * at the fork cut. The Gateway authorizes the addressed Session through the
 * `sessionId` field the Session Controller registers as the `session`
 * resource, so a caller without access fails with `remote-access/denied`
 * before this method runs.
 * @param request - Session and event to read.
 * @param signal - cancellation for the Session read.
 * @returns the request view.
 * @throws RemoteError `session/not-found` when the Session does not exist.
 * @throws RemoteError `loom/seq-out-of-range` when `seq` is not a seq of the log or precedes the first request settlement.
 * @throws RemoteError `gateway/internal` when the log holds no `request/header` before the addressed request.
 */
@Remote async requestAt(request: LoomRequestAtRequest, signal: AbortSignal): Promise<LoomRequestView>

/**
 * Fork a current tool result, replace only its content, then continue the child.
 * The original tool metadata and success/error classification are retained.
 * @param request - source Session, current result and replacement text.
 * @param signal - cancellation before child continuation admission.
 * @returns the new branch and its content replacement event.
 */
@Remote counterfactual(request: LoomCounterfactualRequest, signal: AbortSignal): Promise<LoomCounterfactualValue>

/**
 * Generate prose siblings at a cursor without changing Chat history.
 * @param request - cursor, authored prefix, sibling count and generation controls.
 * @param signal - caller cancellation.
 * @returns settled siblings in dispatch order, including failures.
 */
@Remote weave(request: LoomWeaveRequest, signal: AbortSignal): Promise<LoomWeaveValue>

/**
 * Read a persisted prose document without activating an Agent.
 * @param request - Session whose prose records to read.
 * @param signal - caller cancellation.
 * @returns generated nodes, current choices and curation totals.
 */
@Remote weaveState(request: LoomWeaveStateRequest, signal: AbortSignal): Promise<LoomWeaveState>

/**
 * Select one completed prose continuation and retain its curation credit.
 * @param request - Session and chosen node.
 * @param signal - caller cancellation.
 * @returns current curation bits and selected model-token count.
 */
@Remote choose(request: LoomChooseRequest, signal: AbortSignal): Promise<LoomCurationValue>

/**
 * Explore next-token alternatives within configured breadth and depth limits.
 * @param request - prose cursor and optional tighter controls.
 * @param signal - caller cancellation.
 * @returns captured alternatives and request-budget status.
 */
@Remote probe(request: LoomProbeRequest, signal: AbortSignal): Promise<LoomProbeValue>

/**
 * Prepare an owner-authenticated prose or agent-branch download.
 * @param request - path, sibling set or kept branches and optional output format.
 * @param signal - caller cancellation.
 * @returns the immutable download URL and filename; the snapshot expires by configuration.
 */
@Remote export(request: LoomExportRequest, signal: AbortSignal): Promise<LoomExportValue>

/**
 * Branch one Session into a set of fork children, each cut at the request's
 * turn boundary and sent its own prompt. A regenerate or edit of the first
 * turn a fork Session started itself forks that fork's parent at the fork's
 * cut instead, so the children become further variants beside the fork.
 * Without a `selection`, those children take the route the fork selected
 * before that turn. When that parent no longer exists, the children are cut
 * in the addressed fork instead, below it. Every request validation runs
 * before any fork, except that the Session Controller validates `selection`
 * in each child's fork, so an unavailable route fails each child with
 * `session/model-unavailable` and not the request. A child is
 * forked only when a concurrency slot admits it, so a queued child has no
 * Session; the runner removes the next-turn prompts the child inherited from
 * the cut, writes its `plugin:loom/branch` record, and then sends its
 * prompt. A retry with the same `requestId` for the same Session returns the
 * first result. The Gateway authorizes the addressed Session through its
 * `sessionId` field; the method itself requires `loom/branch` on a fork
 * parent it branches instead.
 * @param request - addressed Session, cut, prompts, and optional route.
 * @returns the set and each child as it stood when the call returned; a child the service's unloading withdrew
 *   meanwhile reads `cancelled`.
 * @throws RemoteError `session/not-found` (the addressed Session), `remote-access/denied`
 *   (the fork parent, while it exists), `gateway/bad-request`, `loom/too-many-branches`, `loom/empty-line`,
 *   `loom/turn-unavailable`, or `gateway/cancelled` (the service unloaded before the set existed), each before
 *   any fork.
 */
@Remote branch(request: LoomBranchRequest): Promise<LoomBranchValue>

/**
 * Branch one Session for a Host caller acting for a model or a plugin:
 * {@link branch} with every validation, admission rule, and retry identity,
 * except that each child's prompt carries `options.source` and
 * `options.prepare` runs on each child before its prompt. It is not a Remote
 * method and authorizes nothing; the caller decides which Sessions it may
 * branch.
 * @param request - addressed Session, cut, prompts, and optional route.
 * @param options - the prompt source and the per-child preparation.
 * @returns the set and each child as it stood when the call returned.
 * @throws RemoteError as {@link branch} does, except `remote-access/denied`.
 */
branchFor(request: LoomBranchRequest, options: LoomHostBranchOptions): Promise<LoomBranchValue>

/**
 * Read the list-price cost of a live Session's own settled requests for a Host budget watcher.
 * Each request uses its logged route; inherited work costs nothing. Reads are incremental and activate no Agent.
 * @param session - live Session to price.
 * @returns USD, or undefined if an own request lacks prices or usage, or no priced route has been logged yet.
 */
ownUsd(session: Session): number | undefined

/**
 * Preview branching from a repeated turn or visible fork family's own usage,
 * or prose from its route's recorded own Weave input and output cap.
 * Ranges are USD at configured list prices when priced, otherwise token counts. The read creates no forks and activates no Agent.
 * The Gateway authorizes the addressed Session through its `sessionId`; family members are filtered by the caller's access.
 * @param request - Session, operation, sibling count, optional route, and turn or prose controls.
 * @param signal - cancellation of Session and projection reads.
 * @returns per-branch and total ranges, cache share, and the source of the token figures.
 * @throws RemoteError `session/not-found`, `gateway/bad-request`, `loom/too-many-branches`, `loom/turn-unavailable`,
 *   `loom/prose-unavailable` for prose limits, or `gateway/internal` when required own usage projections are missing.
 */
@Remote estimate(request: LoomEstimateRequest, signal: AbortSignal): Promise<LoomEstimateValue>

/**
 * Read every child of one branch set from Host memory, which a Host
 * restart clears.
 * @param request - the set.
 * @returns each child's state, Session, and failure.
 * @throws RemoteError `loom/set-not-found` for a set this Host does not hold or whose addressed Session the caller cannot access.
 */
@Remote setStatus(request: LoomSetStatusRequest): LoomSetStatus

/**
 * Withdraw queued children of one branch set before they have a Session.
 * @param request - the set and, optionally, the child indices to withdraw.
 * @returns the indices withdrawn by this call.
 * @throws RemoteError `loom/set-not-found` for a set this Host does not hold or whose addressed Session the caller cannot access.
 */
@Remote cancel(request: LoomCancelRequest): LoomCancelValue

/**
 * Compare the siblings at one fork cut, or the members of one set, by
 * outcome: test summaries from each branch's own command output, changed
 * files, own usage, own wall time, marks, and adoption. Rows cover only
 * Sessions the caller may reach. A worktree row's diff resumes its Session
 * when it is cold. The Gateway authorizes the addressed Session through its
 * `sessionId` field.
 * @param request - a fork, or a set's source or member with the set.
 * @param signal - cancellation of the reads.
 * @returns the parent, the cut, and one row per sibling.
 * @throws RemoteError `session/not-found`, `loom/not-a-fork`, `loom/set-not-found`, or `gateway/internal` when a
 *   sibling's own usage projections are unavailable.
 */
@Remote compare(request: LoomCompareRequest, signal: AbortSignal): Promise<LoomCompareValue>

/**
 * Unified diff of one branch: Git against its base commit for a worktree
 * child, untracked files included, or the change summaries of its own turns
 * for a child that shares the source folder. The Gateway authorizes the
 * Session through its `sessionId` field.
 * @param request - the branch and an optional file.
 * @param signal - cancellation of the reads.
 * @returns the text and whether files were left out to stay within `diff.maxBytes`.
 * @throws RemoteError `session/not-found`, `loom/worktree-unavailable`, or `loom/diff-unavailable`.
 */
@Remote diff(request: LoomDiffRequest, signal: AbortSignal): Promise<LoomDiffValue>

/**
 * Adopt one branch as the line to continue: record `plugin:loom/adopt` in
 * it, then archive its siblings, the other members of its set or the other
 * forks at its cut, through the Workspace registry, stopping their running
 * work first. Nothing is deleted. The Gateway authorizes the branch through
 * its `sessionId` field; the method requires `loom/adopt` on every sibling
 * before any write.
 * @param request - the branch.
 * @returns the branch and every sibling now archived.
 * @throws RemoteError `session/not-found`, `loom/not-a-fork`, `remote-access/denied`, or `loom/adopt-incomplete`.
 */
@Remote adopt(request: LoomAdoptRequest): Promise<LoomAdoptValue>

/**
 * Copy an idle worktree branch's change into the source folder with
 * `git apply`, then remove the worktree. Refused before any write when the
 * source folder has tracked changes, the change does not apply, or it
 * exceeds `apply.maxPatchBytes`. The Gateway authorizes the branch through
 * its `sessionId` field.
 * @param request - the branch.
 * @returns the paths written.
 * @throws RemoteError `session/not-found`, `session/agent-busy`, `loom/apply-not-isolated`, `loom/worktree-unavailable`,
 *   `loom/isolation-unavailable`, `loom/apply-too-large`, `loom/apply-dirty`, `loom/apply-conflict`, or
 *   `loom/worktree-cleanup-failed`.
 */
@Remote apply(request: LoomApplyRequest): Promise<LoomApplyValue>

/**
 * Remove the worktree Loom created for an idle branch, with its files and
 * Git branch; no other worktree is touched. The Gateway authorizes the
 * branch through its `sessionId` field.
 * @param request - the branch.
 * @returns the removed worktree.
 * @throws RemoteError `session/not-found`, `session/agent-busy`, `loom/worktree-unavailable`, or `loom/isolation-unavailable`.
 */
@Remote discard(request: LoomDiscardRequest): Promise<LoomDiscardValue>

/**
 * Set or clear the private mark of one Session, activating it when it is
 * cold, and flush the `plugin:loom/mark` record. A request for the mark the
 * Session already holds writes nothing. Feedback events are never written.
 * The Gateway authorizes the Session through its `sessionId` field.
 * @param request - the Session and its new mark.
 * @returns the mark in force.
 * @throws RemoteError from resolving the Session's Agent, such as `session/not-found`.
 */
@Remote async mark(request: LoomMarkRequest): Promise<LoomMarkValue>
```

Types: [Session](session.zh.md)

Source: [`packages/experimental/loom/src/index.ts`](../../packages/experimental/loom/src/index.ts)
<!-- END GENERATED cordis-surface -->
