---
description: "从插件管理器启用实验性 Loom 分支。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-loom-bundle

[English](README.md) | 中文

## 概述

这个可选组合包启用 Loom 分支、工作树隔离、对比和模型编排探索。Loom 把 fork 出的 Session 视为由分支组成的树：fork 出的会话在切点处显示分支标记，并在对话标题栏显示变体标签；每个 Session 都多出一个阅读 fork 家族的 Loom 标签页。安装包随附此组合包且默认关闭；没有配置档模板选用它，插件管理器在启用前把它列在「更多」中。

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

打开 Web 侧栏中的**插件**，点击**实验性插件**旁的**更多**，启用**织机**；启用后它也会出现在主列表中。该组合包通过首次搜索时打开的内存 SQLite 索引启用多重宇宙内容搜索；未启用 Loom 的配置档仍关闭内容搜索。该组合包没有配置表单；请通过配置档覆盖层配置插件。Autoloom 子会话使用组合包提供的 `loom-child` 权限预设，可在不弹出审批提示的情况下读取内容。[`@deepseek-ai/dsh-experimental-client-ui-loom`](../client-ui-loom/README.zh.md) 说明它显示的内容。开发时，`pnpm dsh web --patch apps/web/tests/loom.overlay.yml` 无需启用组合包即可组合相同的行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

静态 `cordis.patch.yml` 为 [`@deepseek-ai/dsh-experimental-loom`](../loom/README.zh.md) 插入 `loom` 行，为工作树服务插入 `loom-worktree` 行，为五个 autoloom 工具插入 `tool-loom` 行，为 [`@deepseek-ai/dsh-experimental-client-ui-loom`](../client-ui-loom/README.zh.md) 插入 `ui-loom` 行。Loom 及其工作树提供方共享隔离的 `worktrees` 服务，因此无论以何种顺序启用独立的 Worktree 组合包，都不会重复注册同一服务。可选组合包的安装方式让插件管理器可以使用该包，而不在默认配置档中选用它。浏览器插件负责挂载生成的 Remote；稳定的 API Remotes 不导入实验性代码。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[Loom 界面 Agent Note](../../../.agents/notes/implemented/feature/2026-10-18-loom-interface.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过所组合的 [autoloom 工具](../tool-loom/README.zh.md#model-experience)，模型可以在配置的预算内扩展、等待、读取、保留和归档分支。

#### KV 缓存影响

五个工具的 schema 加入模型请求。各分支共享 fork 家族的提示缓存键。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 组合包图标尚待设计师批准。
- Loom 记录是实验性插件记录，Session 格式迁移只尽力保留它们。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
