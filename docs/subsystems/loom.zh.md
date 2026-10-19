# Loom

[English](loom.md) | 中文

实验性 [Loom 服务](../../packages/experimental/loom/README.zh.md)把 fork 出的 Session 视为一棵树。fork Session 复制其源会话的一段精确事件前缀，并把源记录为父会话；Loom 读取这棵树，通过 Session Controller 的 fork 创建分支子会话，并以实验性插件记录添加分支归属与私有标记。[Loom 界面 Agent Note](../../.agents/notes/proposed/feature/2026-10-18-loom-interface.zh.md) 负责分阶段计划。

## fork 家族

`LoomFamily` 是从 Session 列表推导出的一个 Session 的 fork 家族：`rootId` 指向列表中可见的最高 fork 祖先，`focusId` 指向所请求的 Session，`nodes` 按深度优先顺序包含根的全部可见 fork 后代，兄弟节点先按创建顺序、再按 Session id 排列。`LoomFamilyNode` 携带文本为 Session id 的品牌化 `LoomNodeId`、Session id 本身、父节点、深度、该行 `forkLineage` 列表提示存在时给出的创建时间，以及列表状态 `updatedAt`、`running` 与 `blank`。subagent 的父链接不是 fork 链接。浏览器通过 `@deepseek-ai/dsh-experimental-loom/family` 导出从客户端 Session 列表推导家族；Host 的 `family()` 读取服务其他调用方，`LoomFamilyRequest` 指定家族中的任一成员。

## 分支集合

`LoomBranchRequest` 是四种请求之一，每种都指定源 `sessionId`、用于重试的品牌化 `LoomBranchRequestId` 以及可选的 `ModelSelection` 路由：`LoomRegenerateRequest` 与 `LoomEditRequest` 在打开某个 turn 的提示之前切分并重新发送该提示（原样或替换文本），但对于 fork Session 自己开始的首个 turn，它们在该 fork 的切点处 fork 其父会话，除非请求指定路由，否则沿用该 fork 的路由，使子会话成为该 fork 旁边的更多变体，若该父会话已不存在，则在该 fork 自身中切分，位于其下方；`LoomSteerRequest` 与 `LoomVariantsRequest` 在某个 turn 结束处切分并发送每一行，variants 对每个样本各发送一次。运行器只在并发槽位准入子会话时才 fork 它，移除子会话从切点继承的下一 turn 提示，写入子会话的分支记录，然后发送其提示。`LoomBranchValue` 列出每个 `LoomBranchChild`：带 Session 的 `started`、尚无 Session 的 `queued`、带 RemoteError 代码与消息的 `failed`，或在调用期间服务卸载并将其撤回时的 `cancelled`。`LoomSetStatus` 读取同一份 Host 内存中某个 `LoomSetId` 的状态，被 `LoomCancelRequest` 撤回的排队子会话同样报告为 `cancelled`；这份内存不会在 Host 重启后保留，因此重启前的集合报告 `loom/set-not-found`。

## 分支归属与标记

`plugin:loom/branch` 是分支子会话在首次提示前持有的 `LoomBranchRecord`：`LoomSetId`、源 Session 与包含在内的切点 seq、`LoomBranchKind`、子会话按请求顺序从 0 开始的 `index`，以及 variants 子会话所属行的 `variantKey` 摘要。`loomBranch` 投影发布 `{ setId, kind, index, variantKey?, createdAt }` 形式的 `LoomBranchView`，不是 Loom 分支子会话的 Session 为 null。`plugin:loom/mark` 是持有 `LoomMark`（`keep` 或 `set-aside`，或用 null 清除）的 `LoomMarkRecord`；`loomMark` 投影把最后一条发布为 `LoomMarkView`，或为 null。只有位于 Session 继承事件数之后（含）的记录才计入，因此分支或已标记 Session 的 fork 两者皆无。标记从不是反馈事件，遥测导出会移除每条 `plugin:loom/*` 记录的载荷。

## 模型看到的内容

`LoomRequestAtRequest` 指定一个 Session 与任一事件 seq。`LoomRequestView` 描述 settlement（`assistant/message` 或 `assistant/attempt`）位于该 seq 或之前的最新一次模型请求，并按 agent loop 的推导方式从完整日志重建：来自当时生效的 `request/header` 的 `LoomRequestRoute` 与工具名，记录该请求所在 turn 中 `developer/message` 事件所增删工具的 `LoomRequestTools`，包含生效系统提示及其在首个提示之后变化时写入它的 turn 的 `LoomRequestSystemPrompt`，以及每条请求消息对应的一个 `LoomRequestMessage`，带有产生它的 seq、角色、继承标记、有界预览与长度。`inheritedTurns` 与 `ownTurns` 以 fork 切点划分请求之前开始的 turn。该视图是 loop 构建、尚未经提供方路由投影的请求，因此不支持工具更新的路由不会收到 developer 行。不在日志中或早于首个 settlement 的 seq 以 `loom/seq-out-of-range` 失败。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxloom--loom"></a>

### `ctx.loom` — `Loom`

Loom Host service. It registers the `loomBranch` and `loomMark` projection units, the telemetry redaction rule for `plugin:loom/*` records, and the branch runner for its own lifetime, and exposes the `loom` Remote namespace.

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

Source: [`packages/experimental/loom/src/index.ts`](../../packages/experimental/loom/src/index.ts)
<!-- END GENERATED cordis-surface -->
