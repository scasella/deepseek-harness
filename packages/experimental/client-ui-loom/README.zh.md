---
description: "使用和调试实验性 Loom 浏览器插件：分支标记、标题栏变体标签，以及带家族树和阅读窗格的 Loom 标签页。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-loom

[English](README.md) | 中文

## 概述

本包是 Loom 的浏览器部分。在 fork 出的会话中，它在切点处显示一条分支标记，写明父会话以及在同一切点 fork 出的各个变体，并在对话标题栏显示“变体 k/N”标签。它为每个 Session 添加一个 Loom 视图标签页：左侧以可用键盘操作的树展示 fork 家族，右侧以只读文档展示所选 Session 的路径，包括模型在每一轮看到的内容。它挂载 [`@deepseek-ai/dsh-experimental-loom`](../loom/README.zh.md) 的 `loom` Remote。通过 [`@deepseek-ai/dsh-experimental-loom-bundle`](../loom-bundle/README.zh.md) 选用。

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

Web 客户端加载器挂载 `/client` 导出；根 Host 导出不做任何事，本包没有配置字段。插件注入 `remote`、`sessions` 与 `locale`；它的 slot 条目等待已挂载的 `remote.loom` 命名空间、`slots`、`uiConversation` 与 `uiWorkspace`，快捷键参考行等待 `shortcuts`。

| Slot | 条目 | 显示内容 |
|---|---|---|
| `conversation.chat.fork-cut` | `loom-fork-band`，顺序 0 | “分支自 *父会话*，第 *N* 轮之后”、打开父会话链接，以及切点处每个变体的标签，当前变体以 `aria-current` 标记；subagent 子会话不显示 |
| `conversation.session.header.actions` | `loom-variant`，顺序 −30 | “变体 *k*/*N* · 第 *N* 轮之后”及变体菜单；少于两个变体或标题栏窄于 480px 时隐藏 |
| `conversation.view` | `loom`，顺序 20，排在 Trajectory 之后 | 阅读模式下的 Loom 标签页 |

变体是 fork 父会话相同且切点 seq 相同的家族成员，按 `forkLineage.createdAt`、再按 Session id 编号。位于某一轮之中的切点显示为“第 *N* 轮中”：分支标记从 Chat 的 `inheritedTurn` 读取该轮，标题栏标签和树从父会话的 `turnOutline` 读取。位于任何轮次开始之前的切点显示为“首轮结束之前”。变体标签在任何宽度下都保持一行并横向滚动，当前变体标签保持可见，有标签被遮住的一端淡出；宽度低于 480px 时，分支标记还把父会话标题放到单独一行，并去掉“变体”说明。被截断的父会话标题或变体标题会在提示框中完整显示。

### Loom 标签页

树窗格列出家族根、每个父会话下按切点划分的分支点行（“第 *N* 轮之后”或“第 *N* 轮中”，附分支数和各子会话自身的 token 用量），以及每个子会话自身的轮数、步骤数、token 用量和状态点；没有自身轮次的 fork 显示“尚无轮次”。每一层缩进 19px，引导线把每一行连到其父行。通往当前 Session 的路径上的行带有强调色竖线，当前 Session 带有 `aria-current`。按键提示位于树窗格底部。这棵树遵循 APG 大纲树模式，只有一个 Tab 停靠点：上下键移动，Home 与 End 跳到首末，右键展开行或进入第一个子行，左键折叠行或回到父行，Enter 或空格阅读 Session 或切换分支点。按键只在树中的行获得焦点时生效，展开箭头只是指针目标，点击后焦点仍留在该行。快捷键参考在树分组下列出这些按键。两个窗格并排时，浮动输入框通过 ui-conversation 的 `insetComposerStart` 只覆盖阅读窗格；宽度低于 720px 上下堆叠时，它覆盖整个标签页。

阅读窗格显示所选 Session，默认是当前 Session。fork 出的会话先以纯文本显示折叠为首个提示词和最后一条回复的继承轮次，然后是切点，再是每个已加载的自身轮次；fork 模式的 subagent 子会话在与 Chat 相同的位置划分继承轮次和自身轮次，但不显示切点行。每个自身轮次显示提示词、“模型在这一轮看到的内容”展开项、折叠并附本轮推理 token 数的收尾推理，以及回复。展开项在打开时针对该轮收尾的 `assistant/message` 读取 `loom.requestAt`，显示系统提示词长度及该轮是否重建了它、工具数量及该轮新增或移除的工具、继承轮数与自身轮数（会话统计覆盖相同轮次时附步骤数）、该轮自身用量（新输入、缓存与输出 token），以及同一行中的消息数和路由。若 provider 没有为每次尝试报告推理 token，则不显示该数字。对于当前 Session 以外的所选 Session，“在对话中打开”会打开它。发往 `loom` 的视图请求指明要阅读的 Session：若它属于该家族，标签页就阅读它；家族加载后，标签页确认该请求。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

`mountLoom()` 先挂载 Remote 贡献，再在两个内层 fiber 下注册：等待 slot 服务与 `remote.loom` 的 fiber 注册词典、数据源和三个 slot 条目；等待 `shortcuts` 的 fiber 注册树的固定参考行。注册失败时释放两个 fiber 并撤回 Remote。卸载插件时先释放这两个 fiber，再撤回 Remote。视图条目声明标签页存储（所选 Session、折叠的行、持有 Tab 停靠点的行），因此框架为每个 Session 保留一份，切换标签页后状态仍在。

各条目通过三个按键索引的数据源读取，分别绑定为 `useLoomFamily`、`useLoomReader` 与 `useLoomRequest`：

- 家族数据源在被观察期间订阅客户端 Session 列表，用 `@deepseek-ai/dsh-experimental-loom/family` 的 `forkFamily()` 从列表的 `ids` 和每行 `forkLineage` 的创建时间推导家族。未变的节点和家族保留原引用。
- 阅读数据源在被观察期间以引用来源 `loom` 持有其 Session，跟随该 Session 的 Chat 目标，并折叠已加载的轮次：开场用户文本、收尾助手文本与推理、收尾 `assistant/message` 的 seq，以及轮次尾部的推理 token 数与用量。最后一个订阅者离开时释放该 Session。
- 请求数据源在第一个订阅者到来时调用 `loom.requestAt`，最后一个订阅者离开时中止未完成的读取。

每个数据源在最后一个订阅者离开时退出其注册表，因此读者不再查看的内容不会留在内存中；再次观察同一个键时会创建新的数据源并重新读取。失败信息分别说明 `session/not-found`、`loom/seq-out-of-range` 与 `remote-access/denied`；其他代码原样显示。

fork 事实来自列表的投影值：切点来自 `forkLineage`，自身与继承计数来自 `sessionStats.fork`，自身 token 用量来自 `tokenUsage.fork`，继承预览来自 `turnOutline`。成员缺少这些投影时，每个条目在挂载期间只请求一次。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Loom 界面 Agent Note](../../../.agents/notes/proposed/feature/2026-10-18-loom-interface.zh.md)
- [Chat 对话界面](../../client/ui-chat/README.zh.md) — 继承轮次的折叠行和 `conversation.chat.fork-cut` slot。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该浏览器插件只渲染已记录的 Session 数据，不向 Agent 提交内容。

#### KV 缓存影响

没有直接影响；插件只读取 Session 列表、Session 历史和已记录的请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 家族只包含客户端 Session 列表中的 Session，因此隐藏或已删除的 fork 父会话会使家族以其最高的已列出祖先为根。
- 列表行没有 `forkLineage` 值的兄弟节点排在其他兄弟节点之后，直到该值到达。
- 启用组合包后，视图注册表会在每个 Session 上列出 Loom 标签页，因此每个 Session 都会显示标签栏。
- 阅读窗格是已加载轮次的只读摘要，而不是 Chat 记录：省略工具调用和中间步骤，显示的推理来自收尾步骤。嵌入 Chat 会为所读 Session 渲染输入框，并把当前 Session 嵌套在它自己的标签页中。
- 阅读当前 Session 以外的 Session 时，窗格显示期间会在浏览器中打开它的历史。
- 树显示自身 token 用量而不是自身费用，因为 Loom 目前没有价格配置。
- 分支标记只在切点位于 Chat 已加载窗口内时出现；标题栏标签不依赖该窗口。
- 中文文案尚待译者审校。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
