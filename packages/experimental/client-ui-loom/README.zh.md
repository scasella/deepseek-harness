---
description: "使用和调试实验性 Loom 浏览器插件：loom Remote 挂载、其语言命名空间与 fork 家族数据源。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-loom

[English](README.md) | 中文

## 概述

本包是 Loom 的浏览器部分。它挂载 [`@deepseek-ai/dsh-experimental-loom`](../loom/README.zh.md) 生成的 `loom` Remote 贡献，注册 `loom` 语言命名空间，并持有按 Session id 区分、从客户端 Session 列表推导各家族的 fork 家族数据源。它不注册任何插槽条目，因此启用后界面没有可见变化。通过 [`@deepseek-ai/dsh-experimental-loom-bundle`](../loom-bundle/README.zh.md) 选用。

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

Web 客户端加载器挂载 `/client` 导出；根 Host 导出不做任何事，本包没有配置字段。插件注入 `remote`、`sessions` 与 `locale`。

fork 家族数据源在 Session 列表到达前报告 `loading`，随后报告带家族的 `ready`；列表中没有该 Session 时报告 `unlisted`。插槽注册通过 inject 的 `keyedHooks` 分区、以键 `loomFamily` 把数据源交给组件，渲染器将其绑定为 `useLoomFamily(sessionId)`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

`mountLoom()` 先挂载 Remote 贡献，再在等待 `sessions` 与 `locale` 的内层 fiber 下注册词典与家族数据源；注册失败时撤回 Remote。卸载插件时先释放数据源，再撤回 Remote。

每个数据源在第一个订阅者到来时订阅客户端 Session 列表，最后一个订阅者离开时取消订阅。被观察期间，它用 `@deepseek-ai/dsh-experimental-loom/family` 的 `forkFamily()` 从每个就绪的列表快照推导家族，因此成员、创建顺序、`updatedAt`、`running` 与 `blank` 都来自 Host 持续更新的同一份列表。行取自列表的 `ids`，即 Host 列表成员；创建时间取自每行的 `forkLineage` 投影值。事实未变的节点保留原引用，没有改变任何节点的快照保留家族引用。浏览器不调用 Host 的 `loom.family` 读取。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[Loom 界面 Agent Note](../../../.agents/notes/proposed/feature/2026-10-18-loom-interface.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，因为该浏览器插件不渲染任何模型输入，也不向 Agent 提交内容。

#### KV 缓存影响

没有直接影响；插件只读取客户端 Session 列表。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 家族只包含客户端 Session 列表中的 Session，因此隐藏或已删除的 fork 父会话会使家族以其最高的已列出祖先为根。
- 列表行没有 `forkLineage` 值的兄弟节点排在其他兄弟节点之后，直到该值到达。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
