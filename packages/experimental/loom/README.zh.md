---
description: "使用实验性 Loom Host 服务：分支集合、worktree 隔离、按结果比较、采用与应用、私有标记、fork 家族与 loom Remote。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-loom

[English](README.md) | 中文

## 概述

Loom 让你将 Session 分支为多个备选项，可选地把每个分支隔离在 Git worktree 中，跟踪集合、撤回排队子会话，并比较结果与 diff。你可以设置私有标记或采用分支、归档兄弟会话、应用或丢弃隔离变更、浏览 fork 家族、查看模型请求，并从编辑后的工具结果继续。Weave 生成并策展散文续写、探索 token 备选项，并导出带有选择记录的路径。通过 [`@deepseek-ai/dsh-experimental-loom-bundle`](../loom-bundle/README.zh.md) 启用这些实验功能。

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

将本行与 Session Controller、Session 存储、Session 投影注册表、Remote 访问控制、Typert、文件系统和 Workspace 注册表组合；Web 配置档提供这七项。worktree 隔离还需要 [`@deepseek-ai/dsh-experimental-worktree`](../worktree/README.zh.md) 及其注入的 sandbox、子进程与工作目录服务；共享文件夹的子会话的 diff 需要 [`@deepseek-ai/dsh-workspace-changes`](../../deliverables/workspace-changes/README.zh.md)；`compare()` 从 `tokenUsage` 与 `sessionStats` 投影读取自身用量。浏览器部分 [`@deepseek-ai/dsh-experimental-client-ui-loom`](../client-ui-loom/README.zh.md) 挂载本包生成的 `/remote` 贡献。请求与结果类型来自 `@deepseek-ai/dsh-experimental-loom/types`。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxBranchesPerRequest` | `8` | 一次 `branch()` 调用最多创建的子会话数；超出的请求在任何 fork 之前失败。 |
| `maxConcurrentBranches` | `4` | 所有集合中同时处于 fork 过程或正在运行首个提示的 Loom 子会话的最大数量。 |
| `retainedBranchSets` | `256` | Host 内存中保留的已完成集合数。优先淘汰最早创建的已完成集合及其重试结果；活动集合仍保留。 |
| `pricing` | `[]` | 按 provider/model 配置的标价行，`inputMissPerMTok`、`inputHitPerMTok` 与 `outputPerMTok` 的单位为每百万 token 的美元金额。空路由 id、重复路由、负价格或非有限价格会使插件加载失败。 |
| `concurrentWritableBranches` | `false` | 为 false 时，继承的 sandbox 模式可写其文件夹的子会话在同一文件夹内逐个运行；只读子会话与 worktree 子会话不受此限制。 |
| `defaultIsolation` | `shared` | `branch()` 请求未指定 `isolation` 时子会话存放文件的位置：`shared` 或 `worktree`。 |
| `worktreeBranchPrefix` | `loom/` | 每个隔离子会话的 Git 分支与 worktree 目录的前缀，其后接子会话的 Session id；无法作为相对分支名开头的前缀会使插件加载失败。 |
| `outcomes.commandTools` | `bash`，参数 `command` | `compare()` 视为命令输出来读取其结果的工具，每个工具带有指明命令的字符串参数。 |
| `outcomes.testSummary` | unittest、pytest、Vitest、Jest | 测试摘要模式，见[比较兄弟会话](#compare-siblings)；无法工作的模式会使插件加载失败。 |
| `diff.maxBytes` | `262144` | `diff()` 文本的最大 UTF-8 字节数。 |
| `apply.maxPatchBytes` | `33554432` | `apply()` 可复制的最大变更，按其二进制补丁的 UTF-8 字节数计。 |
| `weave` | [Schema 默认值](src/weave.ts) | 辅助散文调用的兄弟数、输出、前缀、超时、框架与缓存预热限制。 |
| `probe` | [Schema 默认值](src/weave.ts) | Token 探索的深度、累积概率、请求数与备选项限制。 |
| `export` | [Schema 默认值](src/export.ts) | 编码字节数、保留下载数与下载存活期上限。 |

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

子会话项在其 Session 已存在、持有分支记录并已发送提示时为 `started`，带有其 `sessionId`；在等待并发槽位且尚无 Session 时为 `queued`；为 `failed` 时带有 RemoteError 的 `code`、`message`，以及失败前已创建 Session 时的 `sessionId`，例如 fork 无法把它附加到源的 Workspace，或拒绝了 `selection` 时；或为 `cancelled`：调用等待该集合首批准入期间 Loom 服务被卸载，并在该子会话拥有 Session 之前撤回了它。一个子会话失败不影响其他子会话。集合仍被保留时，对同一 Session 使用相同 `requestId` 的重试返回首次结果且不创建任何内容；校验失败的请求没有创建任何内容，因此其重试会被重新校验。

以下失败都发生在任何 fork 之前：

| 代码 | 原因 |
|---|---|
| `session/not-found` | 请求所指定的 Session 不存在。 |
| `remote-access/denied` | 调用方无权对首个自身 turn 的 `regenerate` 或 `edit` 所分支的现存 fork 父会话执行分支；`details.action` 为 `loom/branch`。 |
| `gateway/bad-request` | `count`、`samples` 或 `lines` 的数量不是正整数。 |
| `loom/too-many-branches` | 请求的子会话超过 `maxBranchesPerRequest`；`details` 带有 `requested` 与 `limit`。 |
| `loom/empty-line` | 某一行或编辑文本没有非空白字符；`details.index` 指出是哪一行。 |
| `loom/turn-unavailable` | `details.reason` 为 `not-found`（没有该 turn）、`not-ended`（`steer` 或 `variants` 的 turn 没有 `turn/end`）、`not-user-opened`（`regenerate` 或 `edit` 的 turn 不是由用户提示打开）或 `no-cut`（日志的首个事件就接纳了该提示，因此没有前缀能保留其之前的历史）。 |
| `loom/isolation-unavailable` | `isolation: 'worktree'` 请求无法获得 worktree；`details.reason` 见[在 worktree 中隔离子会话](#isolate-children-in-worktrees)。 |
| `gateway/cancelled` | 调用读取所指定的 Session 或 fork 父会话期间 Loom 服务被卸载，此时集合尚不存在。 |

### 跟踪与取消分支集合

`setStatus({ setId })` 返回集合的 `sourceSessionId` 和每个子会话的状态：`started`、`queued`、`failed` 或 `cancelled`；Session 已存在的子会话带有 `sessionId`，失败带有 `code` 与 `message`。正在 fork 的子会话显示为 `queued`。`cancel({ setId, indices? })` 撤回排队中的子会话（省略 `indices` 时撤回全部排队子会话），并返回被撤回的序号；正在 fork 或已开始的子会话不受影响。二者都读取 Host 内存：Host 重启前创建的集合，或其 `branch()` 调用所指定的 Session 无法被调用方访问的集合，以 `loom/set-not-found` 失败。集合被逐出后，`setStatus()` 与 `cancel()` 同样以 `loom/set-not-found` 失败，复用其 `requestId` 会创建新集合。已开始的子会话仍可通过 fork 家族及其 `loomBranch` 值找到。

### 预览标价成本

`estimate({ sessionId, kind, turn?, afterTurn?, count, selection? })` 使用与分支相同的 turn 和数量规则读取数据，不创建 Session，也不调用模型。重新生成和编辑使用所指定 turn 已记录的用量（`basis: 'own-turn'`）；steer、variants 以及没有用量记录的 turn 使用可见 fork 家族平均每个自身 turn 的用量（`basis: 'family'`）。家族根贡献其全部用量，fork 只贡献自身用量，因此继承前缀只计算一次。`selection` 改变计价路由，不改变 token 依据。

配置价格时，`priced` 为 true，`perBranch` 与 `total` 是美元范围：`low` 假定所有输入命中缓存，`high` 假定所有输入未命中，两者均计算已记录的输出；配置的价格顺序相反时仍返回有序范围。未配置价格时，范围表示输入加输出的总 token 数，`priced` 为 false。没有已记录的 token 依据时，两个范围均缺省。`cacheShare` 是观察到的缓存输入占比，没有输入时为零。这些是标价估计，并非实际账单。缓存写入按输入未命中价格计费；输出包括推理 token。默认不附带任何价格。

`estimate({ sessionId, kind: 'weave', count, maxTokens?, prefix?, selection? })` 使用所选 provider/model 上最近一次具有兄弟续写用量记录的自身 Weave 请求，优先选择拼接前缀完全相同的请求。它取这些兄弟续写已记录输入的平均值，并在两个缓存计价端点均按请求的完整输出上限计价；绝不根据文本猜测 token 数。`basis: 'weave-history'`、`historicalInput` 与 `outputCap` 区分历史输入和新光标处的实测用量。该路由没有自身用量时不返回范围；没有配置价格时返回 token 数。探测请求和继承请求不提供依据。续写数量与输出限制使用 `weave.maxSiblings` 和 `weave.maxTokens`；预览不创建 Agent，也不调用提供方。

### 标记一个 Session

`mark({ sessionId, mark })` 在调用方可访问的任一 Session 上设置 `keep` 或 `set-aside`，或用 `null` 清除，并返回生效的标记。Session 为冷状态时会恢复其 Agent。标记是该 Session 中的一条 `plugin:loom/mark` 记录，在调用返回前刷写；请求的标记与 Session 当前标记相同时不写入任何内容。标记从不写入反馈事件。不存在的 Session 以 `session/not-found` 失败。

<a id="isolate-children-in-worktrees"></a>
### 在 worktree 中隔离子会话

在 `branch()` 请求上指定 `isolation: 'worktree'`，或配置 `defaultIsolation: 'worktree'`，会让每个子会话拥有自己的 Git worktree，而不是使用源 Session 的文件夹。在任何 fork 之前，这样的请求会以 `loom/isolation-unavailable` 和一个 `reason` 失败：未组合 worktree 服务时为 `service-unavailable`；切点处的 sandbox 模式不能写入时为 `read-only`；没有 Git 仓库包含源 Session 在切点处的工作目录时为 `no-repository`；在受限模式下，仓库根位于源文件夹之上时为 `subdirectory`，文件夹的 `.git` 条目是文件时为 `linked-checkout`，因为此时 Git 会写入 sandbox 允许的文件夹之外。在 `danger-full-access` 下后两种情况是允许的。

每个被准入的子会话获得分支 `<worktreeBranchPrefix><子会话 Session id>`，以及源仓库中 worktree 服务的池里的一个 worktree，并在其提示之前通过工作目录服务进入该 worktree。一个集合的所有子会话都从同一个基准提交开始，该提交在集合的首个子会话被准入时记录：源文件夹的 HEAD，或 HEAD 之上的一个新提交，其中包含该文件夹对已跟踪文件的已暂存与未暂存变更。未跟踪与被忽略的文件不会被带入，新检出中也不安装任何内容。子会话在其提示之前记录 `plugin:loom/isolation`，其中包含基准提交、worktree 路径、分支与仓库根。worktree 子会话不受“每个文件夹一个写入者”规则限制，可同时运行，最多 `maxConcurrentBranches` 个；Loom 对同一仓库的 worktree 逐个创建、应用和移除。worktree 无法创建的子会话以失败告终：保留其 Session，但没有记录也没有提示。

<a id="compare-siblings"></a>
### 比较兄弟会话

`compare({ sessionId, setId? })` 返回切点的 `parent`、`cutSeq`，以及在切点处或之前有 turn 结束时的 `cutTurn`，并为调用方可访问的每个兄弟会话返回一行。未指定 `setId` 时，兄弟会话是父会话在 `sessionId` 切点处的 fork，此时 `sessionId` 自身必须是 fork；指定时，兄弟会话是该集合的成员，可通过集合的源、任一成员，或位于集合旁边且其首个自身 turn 被该集合重新生成或编辑的 fork 访问。各行按创建时间排序，其次按集合与请求序号，再按 Session id。每行读取该兄弟会话在其切点之后的自身日志：

| 字段 | 来源 |
|---|---|
| `title` | 最新的 Session 标题，或空。 |
| `prompt` | 来自用户或 Loom 的首个自身提示的文本，或空。 |
| `kind`、`isolation` | 自身分支记录；不属于任何集合的 fork 为 `fork`；兄弟会话持有隔离记录时为 `worktree`。 |
| `worktreeEnded` | Loom 是否已应用或丢弃隔离 worktree；共享文件夹不含此字段。仅缺少 diff 不表示 worktree 已结束。 |
| `running` | Session 列表行。 |
| `tests` | 自身命令输出中的最后一个测试摘要，见下文。 |
| `diff` | worktree 中针对基准提交的 Git 结果，包括未跟踪文件；共享文件夹则为该兄弟会话自身各 turn 的变更摘要按文件求和。无法读取时缺省。 |
| `own` | 来自 `sessionStats` 与 `tokenUsage` 投影的 fork 拆分的自身步数与 token；`inputTokens` 计入未缓存输入与缓存写入，`cachedTokens` 计入缓存读取。每个自身请求都有用量与已配置价格时，`usd` 为 `{ amount, label: 'list price' }`；每个请求使用其记录的路由。 |
| `wallMs` | 自身已结束 turn 的时长之和。 |
| `mark`、`adopted` | 自身的标记与采用记录。 |

测试结果来自对 `outcomes.commandTools` 调用的自身结果中面向模型的文本，从不来自工具元数据。每个 `outcomes.testSummary` 模式都与移除了终端控制序列的每个结果进行匹配，`^` 与 `$` 匹配行边界；在含有匹配的最新结果中，结束位置最靠后的匹配胜出。其 `passed`、`failed`、`errors`、`skipped` 与 `total` 模式在匹配到的文本中查找，每个计数取自其第一个捕获组：错误计为失败，缺少总数时由其他计数相加，缺少通过数时为总数减去失败与跳过数。没有失败且总数为正时 `ok` 为 true，`command` 是该调用的命令参数。worktree 行的 diff 会在兄弟会话为冷状态时恢复其 Session；无法读取的 diff 会被记录到日志并省略。`compare()` 以 `loom/not-a-fork` 失败；集合没有可访问成员时以 `loom/set-not-found` 失败；兄弟会话的用量投影未被组合时以 `gateway/internal` 失败。

<a id="read-a-branch-diff"></a>
### 读取分支 diff

`diff({ sessionId, path? })` 为一个分支或 `path` 指明的那个已变更文件返回 Git 风格的统一 diff 文本，按路径顺序逐个文件排列；为不超过 `diff.maxBytes` 而省略了文件时设置 `truncated`。worktree 子会话的文本来自针对其基准提交的 Git，未跟踪文件显示为新文件；共享子会话的文本渲染其自身各 turn 的变更摘要，每个变更了文件的 turn 一节。worktree 已被 Loom 移除（`removed`）或其仓库不再登记它（`missing`）时以 `loom/worktree-unavailable` 失败；本 Host 不持有共享子会话的变更摘要时以 `loom/diff-unavailable` 失败。

<a id="adopt-apply-and-discard"></a>
### 采用、应用与丢弃

`adopt({ sessionId })` 把一个 fork 作为继续推进的主线。它向该 fork 写入一次 `plugin:loom/adopt`，然后通过 Workspace 注册表归档其兄弟会话，并先停止它们正在运行的工作：兄弟会话是其集合中的其他成员；不属于任何集合的 fork 则是其切点处的其他每个 fork。已归档的 Session 保留其日志并可恢复；不会删除任何内容。调用方需要在每个兄弟会话上拥有 `loom/adopt` 权限，该检查在任何写入之前进行（`remote-access/denied`）。它返回该 fork 和每个已归档的兄弟会话；某次归档失败时，以 `loom/adopt-incomplete` 失败并列出已归档与剩余的兄弟会话，重试会完成剩余部分。被采用的分支子会话的 `loomBranch` 值增加 `adopted: true`。

`apply({ sessionId })` 用 `git apply` 把空闲 worktree 子会话的全部变更（包括未跟踪文件）复制到源文件夹，然后移除该 worktree 及其分支，并返回写入的路径。变更只落在工作区中且不暂存，新文件保持未跟踪；变更未涉及的文件保持其字节不变。在任何写入之前：源文件夹的已跟踪文件有已暂存或未暂存的变更时，以 `loom/apply-dirty` 和这些路径失败，因此从未提交工作分支出的集合只有在该工作提交之后才能应用；变更无法应用时以 `loom/apply-conflict` 和这些路径失败；超出 `apply.maxPatchBytes` 时以 `loom/apply-too-large` 失败。共享文件夹的子会话以 `loom/apply-not-isolated` 失败。变更已写入但 worktree 无法移除时，以 `loom/worktree-cleanup-failed` 失败并列出已写入的路径，之后可用 `discard()` 移除该 worktree。`discard({ sessionId })` 移除空闲子会话的 worktree 和分支及其文件，并返回路径与分支。二者都会写入 `plugin:loom/isolation-end`，子会话位于 worktree 内时把它移回仓库根，并且只触及子会话隔离记录所指明的 worktree。正在运行的子会话以 `session/agent-busy` 失败；没有 worktree 的子会话以 `loom/worktree-unavailable`（`shared`、`removed` 或 `missing`）失败。

`apply()` 与 `discard()` 均保留子会话的 `runMaintenance()` 槽位，直到移除操作及其隔离结束记录完成。期间到达的提示等待该槽位完成；另一项维护操作会收到 `session/agent-busy`。

### 读取 fork 家族

`family({ sessionId })` 读取当前 Session 列表而不激活任何 Agent，返回 `sessionId` 的 fork 家族：`rootId` 是列表中可见的最高 fork 祖先，`focusId` 是所请求的 Session，`nodes` 包含根的全部可见 fork 后代。节点按深度优先排列，兄弟节点先按创建时间、再按 Session id 排序；创建时间来自该行的 `forkLineage` 列表提示，没有该提示的兄弟节点排在所有带提示的兄弟节点之后。每个节点带有深度、父节点、已知时的创建时间，以及列表中的 `updatedAt`、`running` 与 `blank` 状态。subagent 的父链接不是 fork 链接，因此 subagent 子会话不属于家族。结果只包含调用方可列出的 Session。未列出的 `sessionId` 以 `session/not-found` 失败。

`@deepseek-ai/dsh-experimental-loom/family` 导出不依赖 Host 的同一推导：`forkFamily(rows, sessionId, previous?)` 接收从任意 Session 列表映射出的 `LoomFamilyRow` 值；传入先前结果时，事实未变的节点保留原引用。浏览器插件用它从客户端 Session 列表推导家族，不调用 `family()`。

### 读取模型看到的内容

`requestAt({ sessionId, seq })` 从 Session 的完整日志重建一次模型请求，不激活其 Agent。`seq` 可以指向任一事件；结果描述 settlement（`assistant/message` 或 `assistant/attempt`）位于该 seq 或之前的最新一次请求，因此重试步骤的每次尝试都对应自己的请求。`LoomRequestView` 包含当时生效的 `request/header` 中的 `route`（提供方、模型与推理强度）和工具 `names`，该请求所在 turn 中、在它之前由 `developer/message` 增删的工具，生效的 `systemPrompt` 文本（不是 Session 首个系统提示时附带写入它的 turn），以及按模型可见顺序排列的全部请求消息。每条消息行带有产生它的 seq、角色（developer 消息报告为 `system`）、该 Session 是否从 fork 源继承了它、折叠空白后至多 `LOOM_REQUEST_PREVIEW_MAX_CODE_POINTS` 个码位的预览，以及以码位计的长度。`inheritedTurns` 与 `ownTurns` 分别统计请求之前在 fork 切点两侧开始的 turn。

不在日志中或早于首个 settlement 的 seq 以 `loom/seq-out-of-range` 失败，其 `range` 给出可指向请求的 seq 范围，尚无请求 settlement 时为 null。未知 Session 以 `session/not-found` 失败；无权访问该 Session 的调用方收到网关的 `remote-access/denied`。

### 替换工具结果并继续

`counterfactual({ sessionId, resultSeq, content })` 从已完成的工具步骤创建 fork，仅替换指定结果的可见文本，然后继续子会话而不添加用户消息。切点保留同一步骤的全部其他结果，因此每个保留的工具调用都有结果。子会话记录 `plugin:loom/tool-result-override` 与仅改内容的 surface 替换；源 Session 保持不变。不完整的工具批次在 fork 之前以 `loom/counterfactual-unavailable` 拒绝。创建子会话后的失败以 `loom/counterfactual-incomplete` 报告，并带有该子会话的 id，以便检查已保留的工作。

### 在光标处生成散文

`weave({ sessionId, parent, prefix, n, controls?, route? })` 创建 `n` 个辅助续写，不产生 Chat 消息或工具。`prefix` 是有序片段列表，片段由用户创作、从已记录的模型节点复制，或从该节点捕获的 token 备选项选出。模型片段必须出现在其引用的节点中；备选片段必须匹配所引用的 token 位置。拼接后的前缀就是精确的 assistant 前缀，`parent` 标识正在扩展的散文节点。所选路由必须支持无工具 assistant 前缀与所请求的对数概率。每个精确请求在分发前记录为 `plugin:loom/weave-request`；每个已结算的兄弟节点（包括失败与取消）都保留为 `plugin:loom/weave-node`。

冷前缀使用 lead-then-burst 调度：先单独启动首个兄弟节点，再于其首个 token 或结算之后等待 `weave.leadDelayMs`，然后启动其余节点。`weave.warmWindowMs` 内重复的前缀同时启动所有兄弟节点。`weaveState({ sessionId })` 在重新加载后重建节点、其精确前缀片段、当前选择、模型 token 与策展位数。`choose({ sessionId, nodeId })` 为每个兄弟集合记录一个已完成的 Weave 选择。更改该选择会替换其计分；再次选择同一节点不写入内容。策展值是这些集合已完成备选数的 `log2(n)` 之和。探测节点与 Session 标记不增加计分。

`probe({ sessionId, parent, prefix, route?, depth?, cutoff? })` 按广度优先探索下一个 token 的备选项。配置的深度与请求数限制约束调用，累积概率对各条路径进行剪枝。每次探测使用与 Weave 相同的已记录辅助请求和节点记录；返回的备选项引用其已记录节点与 token 位置，使后续续写能够保留其归属。仅在记录的 token 序列覆盖精确输出文本时公开概率。

散文拒绝包含 `reasonCode`，用于区分路由能力、限制、前缀归属、路由选择、活动工作、提供方失败或取消。不支持的前缀与 token 概率在任何请求记录或模型调用之前被拒绝。失败节点在诊断文本之外保留提供方中立的 `failureCode`。探测结果把已采样位置与保留的备选项分开列出，使客户端能够区分未探索的路径和已采样但省略了部分概率质量的位置。

### 导出路径或选择

`export({ sessionId, mode, nodeId?, format? })` 为有界、不可变的快照返回经所有者认证的下载 URL。`mode` 为 `path`、`siblings` 或 `kept`；`format` 默认为 `json`，也可为 `text` 或 `html`。指定 `nodeId` 时，快照包含所选散文路径、其兄弟节点，或当前选中的散文节点，包括片段与策展记录。否则包含 Session 历史、相同切点的兄弟历史，或可见 fork 家族中保留的 Session。文本与 HTML 在可读文本之后保留完整 JSON 记录。URL 在 `export.ttlMs` 后过期；达到 `export.maxDownloads` 时淘汰最早的下载，超过 `export.maxBytes` 的快照在创建 URL 之前被拒绝。没有连接服务或调用方不是所有者时，操作报告 `loom/export-unavailable`。

### 分支归属与标记

`plugin:loom/branch` 是一种可忽略的插件记录，分支子会话在首次提示前持有它：所属集合、源 Session 及切点 seq、kind、子会话序号，以及 `variants` 子会话的 `variantKey`。`loomBranch` 投影从第一条有效的自有记录发布 `{ setId, kind, index, variantKey?, createdAt }`，以记录的时间作为 `createdAt`；不是 Loom 分支子会话的 Session 为 `null`。`plugin:loom/mark` 记录 `{ version, mark }`；`loomMark` 投影把最后一条自有标记发布为 `{ mark }`，或为 `null`。`plugin:loom/isolation` 记录 `{ version, baseCommit, worktreePath, branchName, repositoryRoot }`，`plugin:loom/isolation-end` 记录带有 `applied` 或 `discarded` 的 `{ version, reason }`，`plugin:loom/adopt` 记录 `{ version, setId? }`；有效的自有采用记录之后，`loomBranch` 值增加 `adopted: true`。两个单元都忽略 Session 继承事件数之前的记录（分支或已标记 Session 的 fork 会继承这些记录），也忽略载荷校验失败的记录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

`Loom` 继承 `TypertRemoteService`，服务键与命名空间均为 `loom`。其构造函数在自身 fiber 上注册 `loomBranch` 与 `loomMark` 单元、一个 `session-telemetry/record` 监听器以及分支运行器的拆除逻辑，因此卸载插件会移除全部这些内容。网关通过 Session Controller 注册为 `session` 资源的 `sessionId` 字段，对 `branch()`、`mark()`、`family()` 与 `requestAt()` 所指向的 Session 进行授权。`setStatus()` 与 `cancel()` 不指向任何 Session，因此网关针对 `global` 资源检查它们；方法随后还要求 `ctx.remoteAccess.allows()` 对集合的 `branch()` 调用所指定的 Session 允许本次调用的动作，因此非所有者需要同时具备这两项授权。`family()` 以同样方式过滤列表行。

`branch()` 用 `ctx.sessionController.inspect()` 读取请求所指定的 Session，并在一个步骤 `resolveBranch()` 中解析请求，得到切点、每个子会话的内容、切点处待处理的下一 turn 提示（`inheritedNextTurnPrompts()`）、浏览器时区、子会话能否写入以及其文件夹。切点使用 Session Controller 的 `completedPrefixBefore()`，源 Session 最后一个已完成 turn 的结束处则使用 `latestCompletedPrefixBoundary()`。打开第 k 轮的提示是 `turn/start(k)` 时下一 turn 队列的队首，前提是它以来自 `user` 来源的 `user/message` 进入该 turn。当 `regenerate` 或 `edit` 指定的是 fork 继承事件数处或之后的第一个 `turn/start`，且该 fork 不是 subagent 子会话时，来源是头部的 `parentSession`，切点是继承事件数减一；该 fork 截至此切点的日志就是父会话的日志，因此从中读取排队提示与 sandbox 模式。请求未指定 `selection` 时，若该 fork 首次请求记录的路由不同于切点处的路由，则子会话采用前者；否则采用继承事件之后、该 `turn/start` 之前最后一个 `model/selection`。在任何 fork 之前，运行器要求 `ctx.remoteAccess.allows()` 对父会话允许本次调用的 `loom/branch` 动作，因为网关只授权了该 fork，然后检查父会话，使缺少该授权的调用方以 `remote-access/denied` 失败。`inspect()` 报告 `session/not-found` 的父会话会使运行器在 `redirect` 为 false 的条件下重新解析请求，像其他 turn 一样在所指定的 fork 中切分；其他读取失败则向上传播。除非切点之前最后一个 `sandbox/mode` 事件（或其次已组合的 `sandboxPolicy` 默认值）为 `read-only`，子会话都视为可写；未组合 sandbox 策略时每个子会话都视为可写。其文件夹是请求所指定 Session 头部的 `cwd`，fork 会从父会话复制该值。

运行器在插件生命周期内把集合保存在 Host 内存中。准入按顺序扫描队列，准入槽位规则允许的每个子会话，因此同一集合的子会话按序号开始，各集合按请求顺序开始；因文件夹而受阻的可写子会话不会挡住其后的只读子会话。一次准入调用 `ctx.sessionController.fork({ sessionId, atSeq, selection? })`，解析子会话的 Agent，用 `agent.inbox.remove()` 移除每条继承的下一 turn 提示，用 `appendPluginRecord()` 追加分支记录，用 `agent.followup()` 发送提示，并等待 `ctx.sessions.flush()`。槽位从准入开始一直保持到子会话的 Agent 在提示之后达到整体空闲（`agent.whenIdle()`）；若提示之前的某一步失败则立即释放。拆除时撤回排队中的子会话，并等待所有进行中的准入完成，因此不会留下缺少记录与提示的 fork。仍在等待其集合准入的 `branch()` 调用随后返回该集合，被撤回的子会话为 `cancelled`，因为已准入的子会话会继续运行，调用方要凭集合 id 跟踪它们；在集合存在之前就被拆除赶上的调用以 `gateway/cancelled` 失败。测试使用真实 agent loop 和以插件挂载的 Session Controller 覆盖每项 Host 契约；`branch.e2e.ts` 在 OpenRouter DeepSeek 路由上运行 regenerate 与 steer 集合。

隔离在 `resolveBranch()`（它应用 `defaultIsolation`）之后由 `resolveIsolation()` 解析：它读取源文件夹与切点处的工作目录，向 `ctx.worktrees.locate()` 查询仓库，并通过 `ctx.fs` 比较仓库根与该文件夹。准入时用 `ctx.worktrees.create()` 创建每个 worktree：集合的首个子会话使用 `includeUncommitted`，其余子会话以该子会话的基准提交作为 `from`；创建在仓库的队列轮次中进行，`apply()` 与 `discard()` 共用该队列。`compare()`、`diff()`、`apply()` 与 `discard()` 通过 `ctx.worktrees.git()` 或 `ctx.worktrees.remove()` 运行每条 Git 命令，二者禁用 hook 与文件系统监视器，并把命令限制在子会话自身的 Session 策略中；`git apply` 还会禁用已配置的过滤器。读取操作附加 `--no-optional-locks`、`--literal-pathspecs`、`--no-ext-diff` 与 `--no-textconv`，用 `git ls-files --others --exclude-standard` 列出未跟踪文件，并对每个未跟踪文件运行一次 `git diff --no-index`。`apply()` 由这些 diff 构建一个 `--binary` 补丁，在源检出中检查 `git status --porcelain --untracked-files=no` 与 `git apply --check`，再用 `git apply` 应用；卸载不会取消这次写入。各行用 `ctx.sessionController.inspect()` 与 `projections()` 读取每个兄弟会话，兄弟会话本身来自经 `ctx.remoteAccess.allows()` 过滤的 `list()`。这些操作持有一个生命周期中止信号和一个待处理集合，插件拆除时会中止并等待它们。Host spec 在临时 Git 仓库上验证它们，`isolation.e2e.ts` 在 OpenRouter DeepSeek 路由上运行两个 worktree 子会话、一次比较、一次应用和一次丢弃。

`branchFor(request, { source, prepare? })` 是 Host 专用入口，保留相同的分支校验、准入与重试标识。它不执行授权：调用方负责 Session 访问。`prepare` 在每个子会话的分支记录之后、提示之前运行；抛出异常会使该子会话失败且不发送提示。Autoloom 用它设置非交互权限和 `loom` 消息来源。`ownUsd(session)` 是 Host 专用的同步预算读取，增量折叠新增事件，按每个自身 settlement 记录的路由计价。任何自身请求缺少用量或价格时返回 undefined；尚无自身 settlement 时，仅在已记录路由有价格时返回零。这两个入口均不激活其他 Agent。

脱敏监听器调用 `next()`，把每条 `plugin:loom/*` 账本记录的 `body` 替换为 `null`，并保留 `sourceEvent`。`requestAt()` 读取 `ctx.sessionController.inspect()`（已附加的日志或冷读取），并按 agent loop 的方式推导请求：用 `ctx.sessions.messageProjections` 对 settlement 之前的事件执行 `foldSurface()`，对每个 surface 节点执行 `deriveEventMessage()`，并用 `foldRequestHeader()` 得到请求头。结果等于 loop 传给 `llm/stream` 监听器的请求；host spec 在 fork 的 fork、压缩式 surface 替换和重试步骤上比较二者，Loader 组合 spec 在附带 Loom bundle 补丁的已发布 Web 配置档中比较二者。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[Loom 界面 Agent Note](../../../.agents/notes/implemented/feature/2026-10-18-loom-interface.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 分支子会话提示

#### 模型看到什么

每个分支子会话自身的首次请求以运行器发送的一条 `user` 消息结尾，worktree 子会话在其之前还有进入 worktree 时排入的工作目录通知：`regenerate` 为请求所指定 Session 中打开所指定 turn 的提示内容，逐字节相同；`edit` 为该内容，其文本部分替换为承载请求 `text` 的一个文本部分；`steer` 与 `variants` 为请求中的该行，作为单个文本部分。之前的消息是源 Session 截至切点的请求消息，由 agent loop 从继承的日志重建。源 Session 在切点处排队的提示被移除，永远不会进入子会话的请求。分支记录与标记记录对模型不可见。

#### Token 影响

子会话的首次请求花费继承的前缀加上新提示；带 N 个子会话的请求发送 N 次这样的请求，同时至多 `maxConcurrentBranches` 次。标记、状态读取与取消不增加 token。

#### KV Cache 影响

子会话的首次请求重复源 Session 截至切点的请求前缀并追加新提示，因此当请求到达同一缓存时，提供方可以复用已缓存的前缀。Session Controller 的 fork 为 fork 家族的每个成员赋予家族根的缓存键。若 `selection` 的路由与继承的路由不同，会加入 agent loop 的模型切换提示，并属于另一个缓存。worktree 子会话的目录通知位于继承前缀之后，因此已缓存的前缀不变。比较、diff、采用、应用与丢弃不增加模型输入；`apply()` 写入的变更只能通过读取该文件夹的工具进入之后的请求。

### 辅助散文请求

#### 模型看到什么

Weave 与探测发送配置的 system 和 user 框架以及精确的 assistant 前缀。它们不发送 Session 对话或工具声明，在支持推理的路由上关闭推理，并将生效路由、控制项、框架、前缀片段与流记录在实验性 Loom 记录中。反事实继续使用普通循环请求，包含被替换的工具结果文本与全部其他结果。

#### Token 影响

每个兄弟节点发送完整的带框架前缀，并最多产生解析后的输出限制所允许的 token。探测为每个探索的前缀请求一个输出 token，并在达到请求预算时停止。选择与导出不增加模型调用。策展计量独立于计费 token，统计已完成 Weave 兄弟节点之间的选择。

#### KV Cache 影响

兄弟节点重复精确的请求前缀；lead-then-burst 在其余兄弟节点启动之前，给先导调用时间填充提供方缓存。热前缀缓存是 Host 的调度提示，不保证提供方缓存命中。编辑前缀会改变可复用的后缀；改变路由或框架会使用不同的调度键。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 分支集合只保存在 Host 内存中。Host 重启会丢弃所有集合：其排队中的子会话永远不会开始，`setStatus()` 与 `cancel()` 报告 `loom/set-not-found`。已开始的子会话保留其 Session 与记录。
- 活动集合保留在内存中；最多保留 `retainedBranchSets` 个已完成集合及其 `requestId` 结果。所有已准入子会话达到整体空闲或失败、且所有排队子会话均被撤回后，集合才完成；淘汰不会删除 Session 或 worktree。
- `concurrentWritableBranches` 为 false 时，运行器只串行化共享同一文件夹的 Loom 子会话的首个提示。源 Session、其他 Session 以及子会话中的后续提示仍会同时写入同一文件夹，同时运行的共享子会话的变更摘要可能把彼此的编辑归到对方名下；worktree 隔离为使用它的子会话消除了这种重叠。
- worktree 集合的基准在其首个子会话被准入时记录；所有槽位都忙时，这晚于 `branch()` 调用。未跟踪与被忽略的文件不会被带入，依赖不会被安装，没有任何提交的仓库会使每个子会话失败。
- worktree 一直保留到 `apply()` 或 `discard()`；采用或归档分支会保留其 worktree。
- `apply()` 复制补丁，从不快进或合并，并拒绝源文件夹中的任何已跟踪变更，包括集合基准所带入的未提交工作。
- `compare()` 会恢复冷状态的 worktree 兄弟会话以读取其 diff，每个未跟踪文件运行一个 Git 进程，并且只有在本 Host 持有共享子会话的变更摘要时才能读取其 diff，而 `workspace-changes` 只为活跃 Session 保留这些摘要。测试结果是对命令输出的模式匹配；摘要不被任何模式匹配的运行器不报告结果。
- 子会话的槽位持续到其 Agent 达到整体空闲，因此用户向正在运行的子会话发送的提示会延长槽位占用。
- 子会话的提示是带新 id 的新消息，而不是源消息。`regenerate` 在没有新上传凭据的情况下重新发送已存储的图片与文件引用；需要 Agent 重新绑定的文件引用尚未验证。
- `mark()` 会恢复冷 Session 的 Agent 以追加记录。
- Loom 记录是实验性插件记录。Session 格式迁移只尽力保留它们；`plugin:loom/branch` 记录丢失后，`loomBranch` 会把该 Session 报告为普通 fork；`plugin:loom/mark` 记录丢失则清除其标记。
- `family()` 每次调用都读取完整 Session 列表，并在隐藏、已删除或超出调用方访问权限的父会话处停止，因此这类家族以其最高的可见祖先为根。
- 导出的遥测仍携带每条 Loom 记录的信封，包括类型和 seq；只移除载荷。
- `requestAt()` 描述 agent loop 构建的请求，即提供方路由投影之前的形式：不支持工具更新的路由收到的消息不含 developer 行，只能从工具列表得知工具变化；文件与已卸载的图片块在每条路由上都以句柄文本送达。
- `requestAt()` 每次调用都读取并折叠完整日志，返回全部消息和完整的系统提示文本，不分页。
- 辅助散文需要明确支持前缀的路由。它不会继续包含工具的 Chat 历史；生成的散文保留在其独立记录的节点树中。
- 散文操作持有 Session 的维护槽位，卸载会中止并等待其调用。Host 热前缀提示与下载 URL 在重启后丢失；已记录的散文树与选择保留。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
