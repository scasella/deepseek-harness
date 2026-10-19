---
description: "从插件管理器启用实验性 Loom 分支。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-loom-bundle

[English](README.md) | 中文

## 概述

探索不同的 Agent 任务和散文续写，同时保留其他分支。此可选组合包添加织机树与阅读器、带工作树操作的对比、支持词元探索与导出的编织、多重宇宙搜索，以及带预算的 autoloom 工具。在 Web 插件管理器中启用；默认关闭。请使用包含所需核心 API 的配套 Harness 构建。

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

打开 Web 侧栏中的**插件**，选择**实验性插件**旁的**更多**，然后启用**织机**。按照[织机指南](../../../docs/user/guide/loom.zh.md)创建分支、对比、继续和导出。配套的 Harness 版本必须包含该组合包及核心更改；已经发布的 `0.2.1-rc.2` 运行时不提供这些 API。

### 从源码检出安装

在已准备好且包含织机的源码检出中，将本地组合包添加到 Web 配置档：

```sh
pnpm dsh plugin --profile web add link:./packages/experimental/loom-bundle --offline
pnpm dsh web --dump-config
```

输出包含 `loom`、`loom-worktree`、`tool-loom` 和 `ui-loom`。包管理器可能提示链接的 Cordis 对等依赖警告；内置组合包及其依赖从 Harness 安装目录解析。命令使用所选的 `DSH_HOME`；试用时请使用临时主目录。移除此层的命令为：

```sh
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-experimental-loom-bundle
```

移除操作从组合后的配置档撤下织机，同时保留会话文件。重新启动 Web 配置档以加载更改后的组合。这些源码命令不表示尚未发布的功能已经可通过 npm 获取。

### 配置与权限

组合包没有配置表单；请通过配置档覆盖层配置[织机服务](../loom/README.zh.md)与 [autoloom 工具](../tool-loom/README.zh.md)。Autoloom 子会话使用组合包提供的 `loom-child` 预设：只读且不弹出审批提示。工作树分支需要 Git 仓库与工作区写入权限。默认不提供价格；配置后的费用为标价。

多重宇宙内容搜索使用首次搜索时打开的内存 SQLite 索引；未启用织机的配置档保持内容搜索关闭。组合包也会写入权限预设配置，因此后续覆盖层若更改该配置，必须保留仍需使用的预设。

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

- [织机指南](../../../docs/user/guide/loom.zh.md) — 面向任务的 Web 使用流程。
- [织机服务](../loom/README.zh.md) — 隔离、价格、记录和限制。
- [织机界面 Agent Note](../../../.agents/notes/implemented/feature/2026-10-18-loom-interface.zh.md) — 决策依据。

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
- Host 重启会丢失排队的分支准入、autoloom 预算、热前缀提示和下载 URL。已经启动的会话、已记录的散文和选择仍然保留。
- 采用与归档保留工作树；应用与丢弃负责明确清理。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
