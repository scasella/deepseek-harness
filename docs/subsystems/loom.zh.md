# Loom

[English](loom.md) | 中文

实验性 [Loom 服务](../../packages/experimental/loom/README.zh.md)把 fork 出的 Session 视为一棵树。fork Session 复制其源会话的一段精确事件前缀，并把源记录为父会话；Loom 读取这棵树，并以实验性插件记录添加分支归属。[Loom 界面 Agent Note](../../.agents/notes/proposed/feature/2026-10-18-loom-interface.zh.md) 负责分阶段计划。

## fork 家族

`LoomFamily` 是从 Session 列表推导出的一个 Session 的 fork 家族：`rootId` 指向列表中可见的最高 fork 祖先，`focusId` 指向所请求的 Session，`nodes` 按深度优先顺序包含根的全部可见 fork 后代，兄弟节点先按创建顺序、再按 Session id 排列。`LoomFamilyNode` 携带文本为 Session id 的品牌化 `LoomNodeId`、Session id 本身、父节点、深度、该行 `forkLineage` 列表提示存在时给出的创建时间，以及列表状态 `updatedAt`、`running` 与 `blank`。subagent 的父链接不是 fork 链接。浏览器通过 `@deepseek-ai/dsh-experimental-loom/family` 导出从客户端 Session 列表推导家族；Host 的 `family()` 读取服务其他调用方，`LoomFamilyRequest` 指定家族中的任一成员。

## 分支归属

`plugin:loom/branch` 是分支子会话在首次提示前持有的 `LoomBranchRecord`：其分支请求的 `LoomSetId`、源 Session 与包含在内的切点 seq、在 `variantCount` 个子会话中从 1 开始的 `variant`、`LoomBranchKind`，以及可选的 `variantKey` 与 `LoomRunId`。`loomBranch` 投影发布 `{ inheritedEventCount, branch }` 形式的 `LoomBranchView`；只有位于 Session 继承事件数之后（含）的记录才算归属。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxloom--loom"></a>

### `ctx.loom` — `Loom`

Loom Host service. It registers the `loomBranch` projection unit and the telemetry redaction rule for `plugin:loom/*` records for its own lifetime, and exposes the `loom` Remote namespace.

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
```

Source: [`packages/experimental/loom/src/index.ts`](../../packages/experimental/loom/src/index.ts)
<!-- END GENERATED cordis-surface -->
