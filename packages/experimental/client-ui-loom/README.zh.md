---
description: "使用和调试实验性 Loom 浏览器插件：分支标记、标题栏变体标签、从某一轮分支、私人标记，以及带家族树和阅读窗格的 Loom 标签页。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-loom

[English](README.md) | 中文

## 概述

本包是 Loom 的浏览器部分。fork 出的会话在切点处显示分支标记，并在标题栏显示“变体 k/N”标签。已完成的轮次获得多路分支、多次重新生成、兄弟变体翻页器以及私人的“保留”和“搁置”标记，开启该轮的用户消息获得“编辑并分支”，停靠栏中的状态条跟踪运行中的分支。每个 Session 获得一个 Loom 标签页，可用键盘操作的家族树旁是所选路径的只读文档。它挂载 [`@deepseek-ai/dsh-experimental-loom`](../loom/README.zh.md) 的 `loom` Remote。通过 [`@deepseek-ai/dsh-experimental-loom-bundle`](../loom-bundle/README.zh.md) 选用。

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

Web 客户端加载器挂载 `/client` 导出；根 Host 导出不做任何事，本包没有配置字段。插件注入 `remote`、`sessions` 与 `locale`；它的 slot 条目等待已挂载的 `remote.loom` 命名空间、`slots`、`uiConversation` 与 `uiWorkspace`，路由选择器等待 `session` Remote，快捷键参考行等待 `shortcuts`。

| Slot | 条目 | 显示内容 |
|---|---|---|
| `conversation.chat.fork-cut` | `loom-fork-band`，顺序 0 | “分支自 *父会话*，第 *N* 轮之后”、打开父会话链接，以及切点处每个变体的标签，当前变体以 `aria-current` 标记；subagent 子会话不显示 |
| `conversation.session.header.actions` | `loom-variant`，顺序 −30 | “变体 *k*/*N* · 第 *N* 轮之后”及变体菜单；少于两个变体或标题栏窄于 480px 时隐藏 |
| `conversation.chat.assistant-actions.after` | `loom-branch-caret` 0、`loom-pager` 10、`loom-regenerate` 20、`loom-marks` 30 | 分支按钮之后的多路分支箭头、兄弟变体翻页器、重新生成拆分按钮，以及“保留 / 搁置”组 |
| `conversation.chat.user-actions` | `loom-edit-branch`，顺序 10 | 开启其所在轮次的用户消息下的“编辑并分支” |
| `conversation.input.dock` | `loom-running` 14、`loom-branch-form` 16 | 运行中分支状态条和多路分支表单，位于目标卡片与排队面板之间 |
| `conversation.view` | `loom`，顺序 20，排在 Trajectory 之后 | 阅读模式下的 Loom 标签页 |

变体是 fork 父会话相同且切点 seq 相同的家族成员，按 `forkLineage.createdAt`、再按 Session id 编号。位于某一轮之中的切点显示为“第 *N* 轮中”：分支标记从 Chat 的 `inheritedTurn` 读取该轮，标题栏标签和树从父会话的 `turnOutline` 读取。位于任何轮次开始之前的切点显示为“首轮结束之前”。变体标签在任何宽度下都保持一行并横向滚动，当前变体标签保持可见，有标签被遮住的一端淡出；宽度低于 480px 时，分支标记还把父会话标题放到单独一行，并去掉“变体”说明。被截断的父会话标题或变体标题会在提示框中完整显示。

### 从某一轮分支

分支按钮之后的 Loom 操作需要 `loom/branch` 权限，标记需要 `loom/mark` 权限。每个操作都通过 `loom.branch` 启动一组分支；分支组的子会话是本 Session 的新 fork Session，由主机 fork 并发送提示词，本 Session 保持不变。

- **多路分支**是已完成轮次上紧挨分支按钮的箭头。它在输入区停靠栏中打开表单：每个分支一条引导语、“添加分支”、指出哪些行内容相同的说明、“每行采样数”（×1 至 ×4）、模型行，以及工作区行“子分支共用此文件夹，包括先前分支所做的改动”。“开始”发送在该轮结束处切分的 `steer` 分支组；每行运行多次时发送 `variants` 分支组。主机拒绝时，表单保留草稿并显示失败原因。为其他家族成员打开的表单会写明该 Session。
- **重新生成**是由用户提示词开启的轮次上的拆分按钮。主体部分把该轮重新生成一次；箭头打开面板，其中有 ×1 / ×2 / ×4、单行显示的将重新发送的提示词、模型行、工作区行，以及该轮自身的 token 用量与缓存命中比例。两部分都在该轮提示词之前切分并重新发送它，保留其中的图片和文件。在 fork 的第一个自身轮次上，重新生成和编辑并分支改为在同一切点处 fork 该 fork 的父会话，因此新分支作为更多变体出现在翻页器中，并使用此分支的路由。该父会话已不存在时，Host 改为在此分支中切分，新分支成为它的子分支。
- **模型行**写明分支继承的路由，即“与此分支相同”或“与父会话相同”。`session.modelCatalog` 路由列表加载后，“更换”列出可路由的模型；所选路由只用于这些分支，从不保存为默认值。路由列表加载后，路由以目录中的模型名和强度名显示，加载之前或目录未列出该路由时显示原始 id。重新生成显示该轮首个请求所用的路由，仅在最新一轮才回退到 Session 的最近路由。在 Session 最后一轮之后做“分支 ×N”时，显示尚未被任何请求使用的选择，否则显示最近使用的路由；在较早的轮次之后分支时，显示其下一轮开始时的路由，否则显示该轮结束时的路由，二者都没有则显示“尚未记录路由”。
- **兄弟变体翻页器**“‹ k/N ›”在 fork 有变体时位于它的第一个自身轮次上：变体是父会话和切点都相同的家族成员，编号与分支标记一致。它只有一个 Tab 停靠点；左右键在两个按钮之间移动，Home 与 End 打开第一个和最后一个变体。宽度低于 480px 时，它单独占一行，按钮为 44px，并显示“变体 k/N”。
- **保留与搁置**在 fork 家族中 Session 的最新已加载轮次上自成一组。它们是带 `aria-pressed` 的开关，写入 `loom.mark` 记录，从不作为点赞或点踩反馈；按下状态跟随 `loomMark` 投影，保存进行中时显示正在保存的标记。每个按钮都把其提示（私人标记，从不作为反馈发送）作为无障碍描述。
- **编辑并分支**位于开启某一轮的用户消息下，打开一个面板，在内联编辑器中显示该消息的文本。按 Enter 或“分支”发送 `edit` 分支组：在该消息之前切分，替换其文本，并保留其中的图片和文件；新分支开始后会被打开。
- **运行状态条**位于输入区停靠栏中，在本 Session 启动或作为来源的分支组有子会话运行、待审批、排队或失败时，列出这些分支组的每个子会话：运行中、待审批、已结束、带引导语或“分支 *n*”的排队中，或附原因和下一步的失败。每一行以引导语或“分支 *n*”命名，从不使用 Session 标题，因为 steer 和 variants 子会话继承来源的标题。它统计每种状态，打开已开始的子会话，并通过 `loom.cancel` 取消某个或全部排队的子会话。当家族列出一个 `loomBranch` 指向同一分支组和序号的成员时，排队的子会话就变成该 Session。只剩已结束和失败子会话的分支组会保留到点击“关闭”。

Chat 滚动区窄于 736px 时，带文字的按钮只保留图标，名称移到无障碍名称和提示框中；在不支持悬停的设备上，“保留”和“搁置”保留名称并改为换行，因为那里不显示提示框。提示框只在支持悬停的设备上出现。重新生成面板和编辑并分支面板定位后获得焦点，落在已选中的数量或编辑器上；按 Escape、点击“取消”或分支开始后，焦点回到打开面板的按钮。“分支 ×N”表单在按 Escape 时关闭，除非其中的路由菜单已打开；点击“取消”、按 Escape 或分支开始后，焦点回到打开它的箭头，或在表单来自树时回到 Loom 树的 Tab 停靠位。

### Loom 标签页

树窗格列出家族根、每个父会话下按切点划分的分支点行（“第 *N* 轮之后”或“第 *N* 轮中”，附分支数和各子会话自身的 token 用量），以及每个子会话自身的轮数、步骤数、token 用量和状态点；没有自身轮次的 fork 显示“尚无轮次”。每一层缩进 19px，引导线把每一行连到其父行。通往当前 Session 的路径上的行带有强调色竖线，当前 Session 带有 `aria-current`。按键提示位于树窗格底部。这棵树遵循 APG 大纲树模式，只有一个 Tab 停靠点：上下键移动，Home 与 End 跳到首末，右键展开行或进入第一个子行，左键折叠行或回到父行，Enter 或空格阅读 Session 或切换分支点。g 在本标签页的停靠栏中打开多路分支表单：对 Session 行，在该 Session 最后一个已结束轮次之后分支；对分支点，在该分支点的轮次之后分支，切点位于某一轮之中时除外。k 和 x 切换 Session 行的“保留”和“搁置”。按键只在树中的行获得焦点时生效，展开箭头只是指针目标，点击后焦点仍留在该行。快捷键参考在树分组下列出这些按键。带标记的 Session 在标题后显示其标记，分支点显示其子会话中有几个正在运行。树的下方，每个带提示词变体分支组的分支点列出每一行及其采样数，以及其中保留和搁置的数量。两个窗格并排时，浮动输入框通过 ui-conversation 的 `insetComposerStart` 只覆盖阅读窗格；宽度低于 720px 上下堆叠时，它覆盖整个标签页。

阅读窗格显示所选 Session，默认是当前 Session。fork 出的会话先以纯文本显示折叠为首个提示词和最后一条回复的继承轮次，然后是切点，再是每个已加载的自身轮次；fork 模式的 subagent 子会话在与 Chat 相同的位置划分继承轮次和自身轮次，但不显示切点行。每个自身轮次显示提示词、“模型在这一轮看到的内容”展开项、折叠并附本轮推理 token 数的收尾推理，以及回复。展开项在打开时针对该轮收尾的 `assistant/message` 读取 `loom.requestAt`，显示系统提示词长度及该轮是否重建了它、工具数量及该轮新增或移除的工具、继承轮数与自身轮数（会话统计覆盖相同轮次时附步骤数）、该轮自身用量（新输入、缓存与输出 token），以及同一行中的消息数和路由。若 provider 没有为每次尝试报告推理 token，则不显示该数字。对于当前 Session 以外的所选 Session，“在对话中打开”会打开它。发往 `loom` 的视图请求指明要阅读的 Session：若它属于该家族，标签页就阅读它；家族加载后，标签页确认该请求。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

`mountLoom()` 先挂载 Remote 贡献，再在两个内层 fiber 下注册：等待 slot 服务与 `remote.loom` 的 fiber 注册词典、数据源、分支状态和 slot 条目，并在等待 `remote.session` 的嵌套 fiber 下挂接路由列表；等待 `shortcuts` 的 fiber 注册树的固定参考行。注册失败时释放两个 fiber 并撤回 Remote。卸载插件时先释放这两个 fiber，再撤回 Remote。视图条目声明标签页存储（所选 Session、折叠的行、持有 Tab 停靠点的行），因此框架为每个 Session 保留一份，切换标签页后状态仍在。

各条目通过三个按键索引的数据源读取，分别绑定为 `useLoomFamily`、`useLoomReader` 与 `useLoomRequest`：

- 家族数据源在被观察期间订阅客户端 Session 列表，用 `@deepseek-ai/dsh-experimental-loom/family` 的 `forkFamily()` 从列表的 `ids` 和每行 `forkLineage` 的创建时间推导家族。未变的节点和家族保留原引用。
- 阅读数据源在被观察期间以引用来源 `loom` 持有其 Session，跟随该 Session 的 Chat 目标，并折叠已加载的轮次：开场用户文本、收尾助手文本与推理、收尾 `assistant/message` 的 seq，以及轮次尾部的推理 token 数与用量。最后一个订阅者离开时释放该 Session。
- 请求数据源在第一个订阅者到来时调用 `loom.requestAt`，最后一个订阅者离开时中止未完成的读取。

每个数据源在最后一个订阅者离开时退出其注册表，因此读者不再查看的内容不会留在内存中；再次观察同一个键时会创建新的数据源并重新读取。失败信息分别说明 `session/not-found`、`loom/seq-out-of-range` 与 `remote-access/denied`；其他代码原样显示。

fork 事实来自列表的投影值：切点来自 `forkLineage`，自身与继承计数来自 `sessionStats.fork`，自身 token 用量来自 `tokenUsage.fork`，继承预览来自 `turnOutline`，子会话的分支组和序号来自 `loomBranch`，其标记来自 `loomMark`。成员缺少这些投影时，每个条目在挂载期间只请求一次。

分支状态属于 UI fiber，所有分支条目通过 `loomBranching` hook 共享：状态条跟踪的分支组、每个停靠栏一份多路分支草稿，以及正在保存的标记。`loom.branch` 为每份草稿生成新的 `requestId`；发生结果未知的传输失败后，重试同一草稿会复用该 id，因此主机不会重复创建。状态条在首次跟踪某个分支组时读取 `loom.setStatus`；此后在该组仍有排队子会话、且某个子会话开始、结束或请求审批时再次读取；当该组有排队子会话而没有运行中或待审批的子会话时，每次读取两秒后再读取一次：主机此时可能正在 fork 下一个子会话，而在子会话拥有 Session 之前失败的 fork 不会改变状态条能看到的其他任何内容。`loom.cancel` 撤回的指定子会话少于状态条显示为排队的子会话时，也会再次读取该分支组。主机不再保留的分支组把排队的子会话显示为未开始。重新加载后在家族中发现正在运行的分支组时，通过 `loom.setStatus` 跟踪它。保存后的标记会一直显示，直到重新读取该 Session 的投影。释放时丢弃这些状态，并忽略仍在进行中的调用结果；分支在主机上继续运行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Loom 界面 Agent Note](../../../.agents/notes/proposed/feature/2026-10-18-loom-interface.zh.md)
- [Chat 对话界面](../../client/ui-chat/README.zh.md) — 继承轮次的折叠行和 `conversation.chat.fork-cut` slot。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该浏览器插件只渲染已记录的 Session 数据，并请求 `loom` 服务启动分支，分支发送的每个提示词、路由和请求都由该服务的分支运行器负责。

#### KV 缓存影响

每个分支都是继承父会话前缀的 fork，因此在支持提示词缓存的路由上，它的第一个请求可以复用家族已缓存的前缀；更换路由会开始新的缓存。读取列表、历史和已记录的请求没有影响。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 家族只包含客户端 Session 列表中的 Session，因此隐藏或已删除的 fork 父会话会使家族以其最高的已列出祖先为根。
- 列表行没有 `forkLineage` 值的兄弟节点排在其他兄弟节点之后，直到该值到达。
- 启用组合包后，视图注册表会在每个 Session 上列出 Loom 标签页，因此每个 Session 都会显示标签栏。
- 阅读窗格是已加载轮次的只读摘要，而不是 Chat 记录：省略工具调用和中间步骤，显示的推理来自收尾步骤。嵌入 Chat 会为所读 Session 渲染输入框，并把当前 Session 嵌套在它自己的标签页中。
- 阅读当前 Session 以外的 Session 时，窗格显示期间会在浏览器中打开它的历史。
- 树、重新生成面板和多路分支表单显示自身 token 用量而不是费用，因为 Loom 目前没有价格配置；在工作树隔离可用之前，工作区行只说明共用文件夹，不提供选择；它也不说明子分支是否逐个运行，因为主机不会把其 `concurrentWritableBranches` 策略告知浏览器。
- 重新加载后发现正在运行的分支组时，其排队子会话在 `loom.setStatus` 返回后才显示；子会话全部排队或全部结束的分支组无法这样发现。
- “保留”和“搁置”图标，以及以 Chat 滚动区而非消息列为基准的窄栏阈值，尚待设计审核。
- 分支标记只在切点位于 Chat 已加载窗口内时出现；标题栏标签不依赖该窗口。
- 中文文案尚待译者审校。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
