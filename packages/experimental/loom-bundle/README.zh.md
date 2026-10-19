---
description: "从插件管理器启用实验性 Loom 分支。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-loom-bundle

[English](README.md) | 中文

## 概述

这个可选组合包组合 Loom Host 服务及其浏览器插件。Loom 把 fork 出的 Session 视为由分支组成的树。安装包随附此组合包且默认关闭；没有配置档模板选用它，插件管理器在启用前把它列在「更多」中。

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

打开 Web 侧栏中的**插件**，点击**实验性插件**旁的**更多**，启用**织机**；启用后它也会出现在主列表中。该组合包没有配置表单，所组合的两个插件也都没有配置字段。启用后没有新增可见控件，因为浏览器插件不注册任何 slot 条目。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

静态 `cordis.patch.yml` 为 [`@deepseek-ai/dsh-experimental-loom`](../loom/README.zh.md) 插入 `loom` 行，为 [`@deepseek-ai/dsh-experimental-client-ui-loom`](../client-ui-loom/README.zh.md) 插入 `ui-loom` 行。可选组合包的安装方式让插件管理器可以使用该包，而不在默认配置档中选用它。浏览器插件负责挂载生成的 Remote；稳定的 API Remotes 不导入实验性代码。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[Loom 界面 Agent Note](../../../.agents/notes/proposed/feature/2026-10-18-loom-interface.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，因为所组合的插件只读取 Session 列表与 Loom 记录，不添加面向模型的内容。

#### KV 缓存影响

没有直接影响；组合包不添加模型请求内容。

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
