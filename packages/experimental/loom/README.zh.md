---
description: "使用实验性 Loom Host 服务：fork 家族、Loom 分支记录与 loom Remote。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-loom

[English](README.md) | 中文

## 概述

`ctx.loom` 服务承载 Loom 的 Host 部分；Loom 把 fork 出的 Session 视为一棵树。它暴露 `loom` Remote 命名空间，用于读取 fork 家族并重建模型在 Session 任一事件处收到的请求；它还声明 `plugin:loom/branch` 记录，把每个 Session 的 fork 切点与分支归属发布为 `loomBranch` 投影，并从导出的遥测中移除 Loom 记录的载荷。通过 [`@deepseek-ai/dsh-experimental-loom-bundle`](../loom-bundle/README.zh.md) 启用。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

将本行与 Session Controller、Session 存储、Session 投影注册表、Remote 访问控制和 Typert 组合；Web 配置档提供这五项。本包没有配置字段。浏览器部分 [`@deepseek-ai/dsh-experimental-client-ui-loom`](../client-ui-loom/README.zh.md) 挂载本包生成的 `/remote` 贡献。

### 读取 fork 家族

`family({ sessionId })` 读取当前 Session 列表而不激活任何 Agent，返回 `sessionId` 的 fork 家族：`rootId` 是列表中可见的最高 fork 祖先，`focusId` 是所请求的 Session，`nodes` 包含根的全部可见 fork 后代。节点按深度优先排列，兄弟节点先按创建时间、再按 Session id 排序；创建时间来自该行的 `forkLineage` 列表提示，没有该提示的兄弟节点排在所有带提示的兄弟节点之后。每个节点带有深度、父节点、已知时的创建时间，以及列表中的 `updatedAt`、`running` 与 `blank` 状态。subagent 的父链接不是 fork 链接，因此 subagent 子会话不属于家族。结果只包含调用方可列出的 Session。未列出的 `sessionId` 以 `session/not-found` 失败。

`@deepseek-ai/dsh-experimental-loom/family` 导出不依赖 Host 的同一推导：`forkFamily(rows, sessionId, previous?)` 接收从任意 Session 列表映射出的 `LoomFamilyRow` 值；传入先前结果时，事实未变的节点保留原引用。浏览器插件用它从客户端 Session 列表推导家族，不调用 `family()`。

### 读取模型看到的内容

`requestAt({ sessionId, seq })` 从 Session 的完整日志重建一次模型请求，不激活其 Agent。`seq` 可以指向任一事件；结果描述 settlement（`assistant/message` 或 `assistant/attempt`）位于该 seq 或之前的最新一次请求，因此重试步骤的每次尝试都对应自己的请求。`LoomRequestView` 包含当时生效的 `request/header` 中的 `route`（提供方、模型与推理强度）和工具 `names`，该请求所在 turn 中、在它之前由 `developer/message` 增删的工具，生效的 `systemPrompt` 文本（不是 Session 首个系统提示时附带写入它的 turn），以及按模型可见顺序排列的全部请求消息。每条消息行带有产生它的 seq、角色（developer 消息报告为 `system`）、该 Session 是否从 fork 源继承了它、折叠空白后至多 `LOOM_REQUEST_PREVIEW_MAX_CODE_POINTS` 个码位的预览，以及以码位计的长度。`inheritedTurns` 与 `ownTurns` 分别统计请求之前在 fork 切点两侧开始的 turn。

不在日志中或早于首个 settlement 的 seq 以 `loom/seq-out-of-range` 失败，其 `range` 给出可指向请求的 seq 范围，尚无请求 settlement 时为 null。未知 Session 以 `session/not-found` 失败；无权访问该 Session 的调用方收到网关的 `remote-access/denied`。

### 分支归属

`plugin:loom/branch` 是一种可忽略的插件记录，分支子会话在首次提示前持有它：分支集合、切出它的源 Session 与 seq、它在集合中的位置，以及集合的派生方式。`loomBranch` 投影发布 `{ inheritedEventCount, branch }`，其中 `inheritedEventCount` 是该 Session 继承的事件数，`branch` 是第一条有效的自有记录。该数量之前的记录继承自 fork 源，从不计为归属；校验失败的载荷会被忽略。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

`Loom` 继承 `TypertRemoteService`，服务键与命名空间均为 `loom`。其构造函数在自身 fiber 上注册 `loomBranch` 单元和一个 `session-telemetry/record` 监听器，因此卸载插件会同时移除两者。网关通过 Session Controller 注册为 `session` 资源的 `sessionId` 字段，对 `family()` 与 `requestAt()` 所指向的 Session 进行授权；`family()` 随后用 `ctx.remoteAccess.allows()` 过滤列表行。`requestAt()` 读取 `ctx.sessionController.inspect()`（已附加的日志或冷读取），并按 agent loop 的方式推导请求：用 `ctx.sessions.messageProjections` 对 settlement 之前的事件执行 `foldSurface()`，对每个 surface 节点执行 `deriveEventMessage()`，并用 `foldRequestHeader()` 得到请求头。结果等于 loop 传给 `llm/stream` 监听器的请求；host spec 在 fork 的 fork、压缩式 surface 替换和重试步骤上比较二者，Loader 组合 spec 在附带 Loom bundle 补丁的已发布 Web 配置档中比较二者。脱敏监听器调用 `next()`，把每条 `plugin:loom/*` 账本记录的 `body` 替换为 `null`，并保留 `sourceEvent`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[Loom 界面 Agent Note](../../../.agents/notes/proposed/feature/2026-10-18-loom-interface.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，因为该服务只读取 Session 列表、Session 日志与 Loom 插件记录，不向模型请求添加任何内容。

#### KV 缓存影响

没有直接影响；插件记录不在模型可见的内容中。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Loom 记录是实验性插件记录。Session 格式迁移只尽力保留它们；`plugin:loom/branch` 记录丢失后，`loomBranch` 会把该 Session 报告为普通 fork。
- `family()` 每次调用都读取完整 Session 列表，并在隐藏、已删除或超出调用方访问权限的父会话处停止，因此这类家族以其最高的可见祖先为根。
- 导出的遥测仍携带每条 Loom 记录的信封，包括类型和 seq；只移除载荷。
- `requestAt()` 描述 agent loop 构建的请求，即提供方路由投影之前的形式：不支持工具更新的路由收到的消息不含 developer 行，只能从工具列表得知工具变化；文件与已卸载的图片块在每条路由上都以句柄文本送达。
- `requestAt()` 每次调用都读取并折叠完整日志，返回全部消息和完整的系统提示文本，不分页。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
