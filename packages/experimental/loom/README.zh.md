---
description: "使用实验性 Loom Host 服务：分支集合、私有标记、fork 家族与 loom Remote。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-loom

[English](README.md) | 中文

## 概述

`ctx.loom` 服务承载 Loom 的 Host 部分；Loom 把 fork 出的 Session 视为一棵树。它的 `loom` Remote 命名空间把一个 Session 分支为若干 fork 子会话组成的集合，报告并取消集合中的子会话，设置私有的保留与搁置标记，读取 fork 家族，并重建模型在 Session 任一事件处收到的请求。它声明 `plugin:loom/branch` 与 `plugin:loom/mark` 记录，把每个 Session 自身的分支归属与标记发布为 `loomBranch` 和 `loomMark` 投影，并从导出的遥测中移除 Loom 记录的载荷。通过 [`@deepseek-ai/dsh-experimental-loom-bundle`](../loom-bundle/README.zh.md) 启用。

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

将本行与 Session Controller、Session 存储、Session 投影注册表、Remote 访问控制和 Typert 组合；Web 配置档提供这五项。浏览器部分 [`@deepseek-ai/dsh-experimental-client-ui-loom`](../client-ui-loom/README.zh.md) 挂载本包生成的 `/remote` 贡献。请求与结果类型来自 `@deepseek-ai/dsh-experimental-loom/types`。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxBranchesPerRequest` | `8` | 一次 `branch()` 调用最多创建的子会话数；超出的请求在任何 fork 之前失败。 |
| `maxConcurrentBranches` | `4` | 所有集合中同时处于 fork 过程或正在运行首个提示的 Loom 子会话的最大数量。 |
| `concurrentWritableBranches` | `false` | 为 false 时，继承的 sandbox 模式可写其文件夹的子会话在同一文件夹内逐个运行；只读子会话不受此限制。 |

### 分支一个 Session

`branch(request)` 从 Session `sessionId` 创建一个分支集合，返回其 `setId`，并按请求顺序为每个子会话给出一项。每个子会话都是顶层 fork Session；源 Session 从不被写入。四种 kind 决定切点和每个子会话的提示：

| `kind` | 字段 | 子会话 | 切点 | 提示 |
|---|---|---|---|---|
| `regenerate` | `turn`、`count` | `count` 个 | 打开 `turn` 的提示之前 | 该提示，原样 |
| `edit` | `turn`、`text` | 1 个 | 打开 `turn` 的提示之前 | 该提示，其文本部分替换为 `text`；图片与文件部分保留其已存储的引用 |
| `steer` | `afterTurn`、`lines` | 每行一个 | `afterTurn` 结束处 | 该行，原样 |
| `variants` | `afterTurn`、`lines`、`samples` | `lines.length × samples` 个，逐行排列 | `afterTurn` 结束处 | 该行，原样；同一行的所有样本共享一个 `variantKey` |

第 k 轮之前的切点保留其之前的所有已完成 turn 以及最后一个 turn 之后的独立事件（例如模型选择），并停在第 k 轮的提示之前。对第 1 轮而言，切点是首个提示之前的独立事件。某一 turn 结束处的切点是它的 `turn/end` 及其后的独立事件，停在下一 turn 或排队输入之前。源 Session 在较早 turn 运行期间排队的提示在切点处仍待处理；运行器在发送子会话自己的提示之前把它从子会话中移除，因此它永远不会在子会话中运行。

对 fork Session 自己开始的首个 turn 执行 `regenerate` 或 `edit` 时，分支位于该 fork 旁边而不是其下方：子会话从该 fork 的父会话在 fork 的切点处 fork 出来，收到该 fork 自己的开场提示（原样或经编辑），并把父会话记录为来源，因此加入该 fork 的变体。未指定 `selection` 时，它们采用该 fork 在该 turn 之前最后选择的路由，因此与该 fork 运行在同一路由上。调用方还必须在父会话上拥有 `loom/branch` 权限。父会话已不存在时，子会话改为在所指定的 fork 中切分，位于其下方，并重发该 fork 自己的开场提示。其他任何 turn，包括 subagent 子会话或非 fork Session 的每个 turn，都在请求所指定的 Session 中切分。

每个子会话的提示带有 `user` 来源：其 `rpcId` 是请求的 `requestId` 后接 `/` 与子会话序号；它带有所替代的源提示记录的浏览器时区（对 `steer` 与 `variants` 而言，取切点处或之前最近一条记录了时区的源提示）；调用方不是所有者时还带有调用方。`selection` 为每个子会话的下一次请求指定路由；Session Controller 的 fork 在子会话被准入时逐个校验它，并只在子会话中记录，因此不可用的路由会使每个子会话以 `session/model-unavailable` 失败，而不是使请求失败。未指定时，子会话沿用 fork 给出的路由。

子会话项在其 Session 已存在、持有分支记录并已发送提示时为 `started`，带有其 `sessionId`；在等待并发槽位且尚无 Session 时为 `queued`；为 `failed` 时带有 RemoteError 的 `code`、`message`，以及失败前已创建 Session 时的 `sessionId`，例如 fork 无法把它附加到源的 Workspace，或拒绝了 `selection` 时；或为 `cancelled`：调用等待该集合首批准入期间 Loom 服务被卸载，并在该子会话拥有 Session 之前撤回了它。一个子会话失败不影响其他子会话。对同一 Session 使用相同 `requestId` 的重试返回首次结果且不创建任何内容；校验失败的请求没有创建任何内容，因此其重试会被重新校验。

以下失败都发生在任何 fork 之前：

| 代码 | 原因 |
|---|---|
| `session/not-found` | 请求所指定的 Session 不存在。 |
| `remote-access/denied` | 调用方无权对首个自身 turn 的 `regenerate` 或 `edit` 所分支的现存 fork 父会话执行分支；`details.action` 为 `loom/branch`。 |
| `gateway/bad-request` | `count`、`samples` 或 `lines` 的数量不是正整数。 |
| `loom/too-many-branches` | 请求的子会话超过 `maxBranchesPerRequest`；`details` 带有 `requested` 与 `limit`。 |
| `loom/empty-line` | 某一行或编辑文本没有非空白字符；`details.index` 指出是哪一行。 |
| `loom/turn-unavailable` | `details.reason` 为 `not-found`（没有该 turn）、`not-ended`（`steer` 或 `variants` 的 turn 没有 `turn/end`）、`not-user-opened`（`regenerate` 或 `edit` 的 turn 不是由用户提示打开）或 `no-cut`（日志的首个事件就接纳了该提示，因此没有前缀能保留其之前的历史）。 |
| `gateway/cancelled` | 调用读取所指定的 Session 或 fork 父会话期间 Loom 服务被卸载，此时集合尚不存在。 |

### 跟踪与取消分支集合

`setStatus({ setId })` 返回集合的 `sourceSessionId` 和每个子会话的状态：`started`、`queued`、`failed` 或 `cancelled`；Session 已存在的子会话带有 `sessionId`，失败带有 `code` 与 `message`。正在 fork 的子会话显示为 `queued`。`cancel({ setId, indices? })` 撤回排队中的子会话（省略 `indices` 时撤回全部排队子会话），并返回被撤回的序号；正在 fork 或已开始的子会话不受影响。二者都读取 Host 内存：Host 重启前创建的集合，或其 `branch()` 调用所指定的 Session 无法被调用方访问的集合，以 `loom/set-not-found` 失败。已开始的子会话仍可通过 fork 家族及其 `loomBranch` 值找到。

### 标记一个 Session

`mark({ sessionId, mark })` 在调用方可访问的任一 Session 上设置 `keep` 或 `set-aside`，或用 `null` 清除，并返回生效的标记。Session 为冷状态时会恢复其 Agent。标记是该 Session 中的一条 `plugin:loom/mark` 记录，在调用返回前刷写；请求的标记与 Session 当前标记相同时不写入任何内容。标记从不写入反馈事件。不存在的 Session 以 `session/not-found` 失败。

### 读取 fork 家族

`family({ sessionId })` 读取当前 Session 列表而不激活任何 Agent，返回 `sessionId` 的 fork 家族：`rootId` 是列表中可见的最高 fork 祖先，`focusId` 是所请求的 Session，`nodes` 包含根的全部可见 fork 后代。节点按深度优先排列，兄弟节点先按创建时间、再按 Session id 排序；创建时间来自该行的 `forkLineage` 列表提示，没有该提示的兄弟节点排在所有带提示的兄弟节点之后。每个节点带有深度、父节点、已知时的创建时间，以及列表中的 `updatedAt`、`running` 与 `blank` 状态。subagent 的父链接不是 fork 链接，因此 subagent 子会话不属于家族。结果只包含调用方可列出的 Session。未列出的 `sessionId` 以 `session/not-found` 失败。

`@deepseek-ai/dsh-experimental-loom/family` 导出不依赖 Host 的同一推导：`forkFamily(rows, sessionId, previous?)` 接收从任意 Session 列表映射出的 `LoomFamilyRow` 值；传入先前结果时，事实未变的节点保留原引用。浏览器插件用它从客户端 Session 列表推导家族，不调用 `family()`。

### 读取模型看到的内容

`requestAt({ sessionId, seq })` 从 Session 的完整日志重建一次模型请求，不激活其 Agent。`seq` 可以指向任一事件；结果描述 settlement（`assistant/message` 或 `assistant/attempt`）位于该 seq 或之前的最新一次请求，因此重试步骤的每次尝试都对应自己的请求。`LoomRequestView` 包含当时生效的 `request/header` 中的 `route`（提供方、模型与推理强度）和工具 `names`，该请求所在 turn 中、在它之前由 `developer/message` 增删的工具，生效的 `systemPrompt` 文本（不是 Session 首个系统提示时附带写入它的 turn），以及按模型可见顺序排列的全部请求消息。每条消息行带有产生它的 seq、角色（developer 消息报告为 `system`）、该 Session 是否从 fork 源继承了它、折叠空白后至多 `LOOM_REQUEST_PREVIEW_MAX_CODE_POINTS` 个码位的预览，以及以码位计的长度。`inheritedTurns` 与 `ownTurns` 分别统计请求之前在 fork 切点两侧开始的 turn。

不在日志中或早于首个 settlement 的 seq 以 `loom/seq-out-of-range` 失败，其 `range` 给出可指向请求的 seq 范围，尚无请求 settlement 时为 null。未知 Session 以 `session/not-found` 失败；无权访问该 Session 的调用方收到网关的 `remote-access/denied`。

### 分支归属与标记

`plugin:loom/branch` 是一种可忽略的插件记录，分支子会话在首次提示前持有它：所属集合、源 Session 及切点 seq、kind、子会话序号，以及 `variants` 子会话的 `variantKey`。`loomBranch` 投影从第一条有效的自有记录发布 `{ setId, kind, index, variantKey?, createdAt }`，以记录的时间作为 `createdAt`；不是 Loom 分支子会话的 Session 为 `null`。`plugin:loom/mark` 记录 `{ version, mark }`；`loomMark` 投影把最后一条自有标记发布为 `{ mark }`，或为 `null`。两个单元都忽略 Session 继承事件数之前的记录（分支或已标记 Session 的 fork 会继承这些记录），也忽略载荷校验失败的记录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

`Loom` 继承 `TypertRemoteService`，服务键与命名空间均为 `loom`。其构造函数在自身 fiber 上注册 `loomBranch` 与 `loomMark` 单元、一个 `session-telemetry/record` 监听器以及分支运行器的拆除逻辑，因此卸载插件会移除全部这些内容。网关通过 Session Controller 注册为 `session` 资源的 `sessionId` 字段，对 `branch()`、`mark()`、`family()` 与 `requestAt()` 所指向的 Session 进行授权。`setStatus()` 与 `cancel()` 不指向任何 Session，因此网关针对 `global` 资源检查它们；方法随后还要求 `ctx.remoteAccess.allows()` 对集合的 `branch()` 调用所指定的 Session 允许本次调用的动作，因此非所有者需要同时具备这两项授权。`family()` 以同样方式过滤列表行。

`branch()` 用 `ctx.sessionController.inspect()` 读取请求所指定的 Session，并在一个步骤 `resolveBranch()` 中解析请求，得到切点、每个子会话的内容、切点处待处理的下一 turn 提示（`inheritedNextTurnPrompts()`）、浏览器时区、子会话能否写入以及其文件夹。切点使用 Session Controller 的 `completedPrefixBefore()`，源 Session 最后一个已完成 turn 的结束处则使用 `latestCompletedPrefixBoundary()`。打开第 k 轮的提示是 `turn/start(k)` 时下一 turn 队列的队首，前提是它以来自 `user` 来源的 `user/message` 进入该 turn。当 `regenerate` 或 `edit` 指定的是 fork 继承事件数处或之后的第一个 `turn/start`，且该 fork 不是 subagent 子会话时，来源是头部的 `parentSession`，切点是继承事件数减一；该 fork 截至此切点的日志就是父会话的日志，因此从中读取排队提示与 sandbox 模式。请求未指定 `selection` 时，子会话的 selection 是该 fork 在继承事件之后、该 `turn/start` 之前记录的最后一个 `model/selection`。在任何 fork 之前，运行器要求 `ctx.remoteAccess.allows()` 对父会话允许本次调用的 `loom/branch` 动作，因为网关只授权了该 fork，然后检查父会话，使缺少该授权的调用方以 `remote-access/denied` 失败。`inspect()` 报告 `session/not-found` 的父会话会使运行器在 `redirect` 为 false 的条件下重新解析请求，像其他 turn 一样在所指定的 fork 中切分；其他读取失败则向上传播。除非切点之前最后一个 `sandbox/mode` 事件（或其次已组合的 `sandboxPolicy` 默认值）为 `read-only`，子会话都视为可写；未组合 sandbox 策略时每个子会话都视为可写。其文件夹是请求所指定 Session 头部的 `cwd`，fork 会从父会话复制该值。

运行器在插件生命周期内把集合保存在 Host 内存中。准入按顺序扫描队列，准入槽位规则允许的每个子会话，因此同一集合的子会话按序号开始，各集合按请求顺序开始；因文件夹而受阻的可写子会话不会挡住其后的只读子会话。一次准入调用 `ctx.sessionController.fork({ sessionId, atSeq, selection? })`，解析子会话的 Agent，用 `agent.inbox.remove()` 移除每条继承的下一 turn 提示，用 `appendPluginRecord()` 追加分支记录，用 `agent.followup()` 发送提示，并等待 `ctx.sessions.flush()`。槽位从准入开始一直保持到子会话的 Agent 在提示之后达到整体空闲（`agent.whenIdle()`）；若提示之前的某一步失败则立即释放。拆除时撤回排队中的子会话，并等待所有进行中的准入完成，因此不会留下缺少记录与提示的 fork。仍在等待其集合准入的 `branch()` 调用随后返回该集合，被撤回的子会话为 `cancelled`，因为已准入的子会话会继续运行，调用方要凭集合 id 跟踪它们；在集合存在之前就被拆除赶上的调用以 `gateway/cancelled` 失败。测试使用真实 agent loop 和以插件挂载的 Session Controller 覆盖每项 Host 契约；`branch.e2e.ts` 在 OpenRouter DeepSeek 路由上运行 regenerate 与 steer 集合。

脱敏监听器调用 `next()`，把每条 `plugin:loom/*` 账本记录的 `body` 替换为 `null`，并保留 `sourceEvent`。`requestAt()` 读取 `ctx.sessionController.inspect()`（已附加的日志或冷读取），并按 agent loop 的方式推导请求：用 `ctx.sessions.messageProjections` 对 settlement 之前的事件执行 `foldSurface()`，对每个 surface 节点执行 `deriveEventMessage()`，并用 `foldRequestHeader()` 得到请求头。结果等于 loop 传给 `llm/stream` 监听器的请求；host spec 在 fork 的 fork、压缩式 surface 替换和重试步骤上比较二者，Loader 组合 spec 在附带 Loom bundle 补丁的已发布 Web 配置档中比较二者。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[Loom 界面 Agent Note](../../../.agents/notes/proposed/feature/2026-10-18-loom-interface.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 分支子会话提示

#### 模型看到什么

每个分支子会话自身的首次请求以运行器发送的一条 `user` 消息结尾：`regenerate` 为请求所指定 Session 中打开所指定 turn 的提示内容，逐字节相同；`edit` 为该内容，其文本部分替换为承载请求 `text` 的一个文本部分；`steer` 与 `variants` 为请求中的该行，作为单个文本部分。之前的消息是源 Session 截至切点的请求消息，由 agent loop 从继承的日志重建。源 Session 在切点处排队的提示被移除，永远不会进入子会话的请求。分支记录与标记记录对模型不可见。

#### Token 影响

子会话的首次请求花费继承的前缀加上新提示；带 N 个子会话的请求发送 N 次这样的请求，同时至多 `maxConcurrentBranches` 次。标记、状态读取与取消不增加 token。

#### KV Cache 影响

子会话的首次请求重复源 Session 截至切点的请求前缀并追加新提示，因此当请求到达同一缓存时，提供方可以复用已缓存的前缀。Session Controller 的 fork 为 fork 家族的每个成员赋予家族根的缓存键。若 `selection` 的路由与继承的路由不同，会加入 agent loop 的模型切换提示，并属于另一个缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 分支集合只保存在 Host 内存中。Host 重启会丢弃所有集合：其排队中的子会话永远不会开始，`setStatus()` 与 `cancel()` 报告 `loom/set-not-found`。已开始的子会话保留其 Session 与记录。
- 集合记录与 `requestId` 结果在插件生命周期内保留，每次 `branch()` 调用一个小条目。
- `concurrentWritableBranches` 为 false 时，运行器只串行化共享同一文件夹的 Loom 子会话的首个提示。源 Session、其他 Session 以及子会话中的后续提示仍会同时写入同一文件夹；为每个子会话隔离 worktree 留待后续阶段。
- 子会话的槽位持续到其 Agent 达到整体空闲，因此用户向正在运行的子会话发送的提示会延长槽位占用。
- 子会话的提示是带新 id 的新消息，而不是源消息。`regenerate` 在没有新上传凭据的情况下重新发送已存储的图片与文件引用；需要 Agent 重新绑定的文件引用尚未验证。
- `mark()` 会恢复冷 Session 的 Agent 以追加记录。
- Loom 记录是实验性插件记录。Session 格式迁移只尽力保留它们；`plugin:loom/branch` 记录丢失后，`loomBranch` 会把该 Session 报告为普通 fork；`plugin:loom/mark` 记录丢失则清除其标记。
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
