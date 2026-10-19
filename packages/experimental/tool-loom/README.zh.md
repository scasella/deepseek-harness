---
description: "五个工具，让 weaver 模型通过 Loom 分支 Session、阅读各分支，并在每个 weaver 的预算内保留或归档它们。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-loom

[English](README.md) | 中文

## 概述

本包在实验性 Loom 服务之上为模型提供五个 autoloom 工具：`loom_expand` 在某个 Session 的一个 turn 之后把它分支为子 Session，`loom_wait` 等待一个分支集合，`loom_read` 读取子会话的最新输出，`loom_keep` 把子会话标记为保留，`loom_cull` 停止子会话并将其归档。调用这些工具的模型所在的 Session 就是 weaver。每个 weaver 都有分支预算、深度预算和自有 token 预算，而 weaver 启动的子会话自身不能使用这些工具。本包以实验性名称公开发布，但不提供稳定性保证。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在同样挂载了 Session Controller、Workspace registry、permission presets、token meter 和 Session query 的组合中（如 Web profile），把本包与 `@deepseek-ai/dsh-experimental-loom` 一起挂载。之后每个 Session 都能看到这五个工具；Session 调用它们即成为 weaver。

### 何时选择

当模型应当自行探索备选方案时选择它：写出若干续写、阅读它们并保留最好的一个，而每个分支都是人可以打开、比较和继续的真实 fork Session。若各分支会在没有隔离的情况下写同一批文件，则避免使用，因为除非 Loom 的 `defaultIsolation` 为每个子会话提供 worktree，子会话会共享源会话的文件夹。

### 最小可用示例

在 Loom 服务之后插入插件：

```yaml
- id: tool-loom
  name: '@deepseek-ai/dsh-experimental-tool-loom'
  config:
    autoloom:
      maxBranches: 8
      maxDepth: 2
      maxOwnTokens: 2000000
      childPermissionPreset: auto
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `autoloom.maxBranches` | `8` | 一个 weaver 最多可启动的子会话数 |
| `autoloom.maxDepth` | `2` | 子会话的最深代数；不由 weaver 启动的 Session 的子会话为第 1 代 |
| `autoloom.maxOwnTokens` | `2000000` | weaver 的全部子会话在自有请求中最多可用的 token 总数 |
| `autoloom.maxUsd` | 省略 | 可选的标价美元上限；没有配置价格的路由会被拒绝 |
| `autoloom.childPermissionPreset` | `auto` | 每个子会话运行时使用的权限预设；其审批策略必须为 `never` |
| `defaultWaitMs` / `maxWaitMs` | `120000` / `1800000` | 未指定超时的 `loom_wait` 等待时长，以及可接受的最长值 |
| `defaultReadChars` / `maxReadChars` | `4000` / `20000` | 未指定上限的 `loom_read` 输出长度，以及可接受的最长值 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-tool-loom)是每个可接受字段及其 JSDoc 的完整来源。`auto` 预设仅在实验性 auto-review 插件加载期间存在；没有它时，请配置审批策略为 `never` 的预设，例如 `{ sandbox: read-only, approval: never }`。配置为 `auto` 以外且需要审批或不存在的预设，会使插件加载失败。

试着对模型说："Session S 中是一个故事的开头一句。探索它的两种续写，保留更好的一个，并归档另一个。"模型会调用 `loom_expand`、`loom_wait`、两次 `loom_read`、`loom_keep` 和 `loom_cull`。

### 模型能做什么

- **分支** —— `loom_expand` 指定一个 Session、每个子会话保留的最后一个 turn（`afterTurn`），以及 `lines`（每个子会话一条提示）或 `count`（把 turn `afterTurn + 1` 的开场提示重新发送这么多次）。目标是工作目录相同的 Session；省略 `sessionId` 时为 weaver 自身。
- **跟进** —— `loom_wait` 等待集合中每个子会话完成其 turn、失败或被撤回，并报告每个子会话的状态和自有 token。`loom_read` 返回子会话最新的助手输出，长度受 `maxChars` 限制。
- **决定** —— `loom_keep` 为子会话设置 Loom 的私有 `keep` 标记。`loom_cull` 停止正在运行的子会话并将其归档；归档保留其历史，人可以从侧边栏恢复它。

通过这些工具只能读取、保留和剔除 weaver 自己的集合与子会话。每个子会话都在其提示之前应用配置的权限预设，因此子会话不会等待一个无人回应的审批。

配置 `maxUsd` 后，每次扩展都需要能纳入剩余标价预算的费用估算。如果子会话结算的自有费用超过预算或无法定价，监视器会停止它们。提供方的实际收费可能与标价不同。

### 成功与失败的表现

每个结果都是带剩余预算的紧凑 JSON：`branchesLeft`、`ownTokensLeft` 和 `maxDepth`。被拒绝的调用不会创建、停止或归档任何东西，其错误文本说明原因，例如 `This Session may start 1 more branches, not 2; no branch was created.` 或 `These branches would be generation 3 of this Session's branches; the limit is 2. No branch was created.`。Loom 拒绝的请求返回 Loom 的消息，例如 `session "S" cannot branch at turn 7: not-found`。未能启动的子会话以 `state: "failed"` 及其错误出现在结果中；只有当其 Session 已存在时，它才计入 `maxBranches`。

当子会话的自有 token 超过 `maxOwnTokens` 时，每个正在运行的子会话都会以取消原因 `loom: autoloom own-token budget exceeded` 被停止，排队的子会话被撤回，`loom_wait` 和 `loom_read` 报告 `stoppedByBudget: true`，之后的每次 `loom_expand` 都会被拒绝。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 —— 点击展开</summary>

本节说明这些工具如何兑现其承诺，并指向相应代码；可观察的行为已在[使用本包](#use-this-package)中完整介绍。

### 设计理念

- **分支归 Loom 所有。** `loom_expand` 为 `lines` 构造 `steer` 请求，或为 `count` 构造对 turn `afterTurn + 1` 的 `regenerate` 请求，并调用 Loom 服务仅限 Host 的 `branchFor`。每条切分规则、准入限制、重试身份和分支记录都由 Loom 负责；工具只增加预算、`loom` 提示来源和子会话准备。
- **决定由 weaver 记录。** 每次扩展、阅读、保留和剔除都是 weaver 日志中的一次工具调用与结果，因此无需新的 Session 事件。
- **先拒绝，后 fork。** 分支、深度和自有 token 预算、目标的工作目录以及子会话预设都在调用 Loom 之前检查，因此被拒绝时不会留下任何 fork。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config`、加载时检查和注册 |
| [`src/tools.ts`](src/tools.ts) | 五个工具的注册 |
| [`src/schemas.ts`](src/schemas.ts) | 参数与结果 schema |
| [`src/runtime.ts`](src/runtime.ts) | weaver 运行、预算、自有 token 监视器、等待、阅读、保留和剔除 |
| [`src/presentation.ts`](src/presentation.ts) | Host 卡片 presenter |
| [`src/types.ts`](src/types.ts) | `loom` 消息来源与 `autoloom/child-refused` 错误代码 |

### 运行与预算

一次运行保存插件加载期间某个 weaver Session 启动的每个集合与子会话，以 weaver 的 Session id 为键，因此卸载后又恢复的 weaver 保留其预算。`maxBranches` 计入每个请求的子会话，但 Loom 报告为失败且没有 Session 的除外。子会话的代数等于目标及其 fork 祖先中 weaver 自己的子会话数量再加一，从 Session query 的谱系读取，因此人对子会话做的 fork 也会计入。`loom_expand` 的调用 id 派生出 Loom 的请求身份，因此重复的调用返回第一次的集合，且只计数一次。

卸载工具会中止待处理的读取、唤醒等待，以 hook 原因 `loom: autoloom tools unloaded` 停止其正在运行的子会话，撤回排队子会话，并在清除运行状态前等待准入中的操作与子会话活动结束。若准入已创建 Session，且准备函数发现卸载，该子会话会被保留但不收到提示。已完成的子会话仍然可用，人可在工具卸载后向它们发送提示。

### 子会话准备

Loom 在每个子会话的 `plugin:loom/branch` 记录之后、提示之前调用工具的准备函数。准备函数通过 permission presets 应用子会话预设，在运行中记录该子会话，并将其标记为 autoloom 子会话。在运行预算耗尽之后或插件卸载之后才被准入的子会话会在此以 `autoloom/child-refused` 失败，且不会收到提示。

### 自有 token 监视器

运行时订阅 token meter 的 `tokenUsage` 单元的投影变更。对于运行中的子会话，它读取 fork 的自有小计，即未缓存输入、缓存读取、缓存写入与输出之和；当运行总量超过 `maxOwnTokens` 时，它以 `hook` 原因取消每个正在运行的子会话，并请 Loom 撤回该运行排队的子会话。监视器在 Session 提交过程中运行，因此撤回失败只会记录日志，绝不抛出。

### Autoloom 子会话

首个自有提示带有 `loom` 来源的 Session 是 autoloom 子会话，每个工具都拒绝在其中运行，因此子会话无法以新的预算开始自己的运行。该检查只读取调用方日志一次，并在首个自有提示存在时缓存结果。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Loom 包](../loom/README.zh.md) —— 分支集合、切分、准入限制、记录与标记。
- [Loom 子系统](../../../docs/subsystems/loom.zh.md) —— `loom` Remote 与 Host 类型。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-loom) —— 模型收到的每个工具 schema。
- [Loom 界面 Agent Note](../../../.agents/notes/implemented/feature/2026-10-18-loom-interface.zh.md) —— 分阶段计划；autoloom 为 L24。

-----

<a id="model-experience"></a>
## 模型体验

### Autoloom 工具 schema

#### 模型看到的内容

挂载本插件的组合中，每个 Session 都会收到生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-loom)所列的五个 schema。`loom_wait` 的 `timeoutMs` 描述与 `loom_read` 的 `maxChars` 描述写明配置的默认值和最大值。结果是紧凑的 JSON 对象，被拒绝时则为工具的错误文本。

#### Token 影响

在挂载本插件的每个 Session 中，这五个 schema 为每次请求增加固定开销。每个结果是一个紧凑的 JSON 对象：`loom_expand` 与 `loom_wait` 随集合中子会话的数量增长，`loom_read` 最多携带 `maxChars` 个码点的输出。

#### KV Cache 影响

同一配置下每个 Session 的 schema 相同，因此分支子会话会重复其源会话的工具前缀。修改 `defaultWaitMs`、`maxWaitMs`、`defaultReadChars` 或 `maxReadChars` 会改变 schema 文本以及每个 Session 的缓存前缀。工具结果追加在可复用前缀之后。

### Autoloom 子会话提示

#### 模型看到的内容

子会话的首个自有请求以 weaver 发送的一条 `user` 消息结尾：`loom_expand` 的那一行原文，或者对于 `count`，目标中打开 turn `afterTurn + 1` 的提示内容。该消息上的 `loom` 来源对模型不可见。子会话更早的消息是目标在切点之前的请求消息，与 Loom fork 时一致。

#### Token 影响

每个子会话的首个请求花费继承前缀加上新提示；子会话的自有请求计入 `maxOwnTokens`，weaver 自己的请求不计入。

#### KV Cache 影响

子会话重复目标在切点之前的请求前缀，而 Session Controller 的 fork 让 fork 家族的每个成员都使用家族根的缓存键，因此提供方可以复用已缓存的前缀。子会话预设在其提示之前把权限开关事件写入子会话日志；这些事件对模型不可见。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **运行保存在 Host 内存中** —— Host 重启或插件重新加载会忘记所有运行：预算重新开始，工具会拒绝早先运行的子会话和集合，但它们在 Loom 标签页中仍可阅读。
- **`count` 只重新采样由人打开的 turn** —— 只有当打开某个 turn 的是 `user` 提示时，Loom 才会重新生成它，因此对 weaver 打开的 turn 使用 `count` 会以 Loom 的 `not-user-opened` 失败；请改用 `lines` 分支子会话。
- **自有 token 监视器按已提交的响应生效** —— 子会话在超出预算的那次响应之后才被停止，因此最后一次响应可能超出 `maxOwnTokens` 或 `maxUsd`，且不限长度的子会话响应不会被截断。
- **fork 失败的排队子会话不会唤醒等待** —— `loom_wait` 会在另一个子会话改变状态或等待超时时报告它。
- **每个 Session 都能看到这些工具** —— 这些 schema 在从不进行分支编排的 Session 中也会消耗 token；只有 autoloom 子会话会被拒绝。
- **没有 Web 卡片** —— Host presenter 只提供带过去时标题的通用卡片。
- **需要 Web 组合** —— `loom_cull` 通过 Workspace registry 归档，而 headless profile 不挂载它。
- **实验性原型，不承诺稳定性** —— 在孵化期间，schema、限制以及 `loom` 来源都可能改变。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 —— 点击展开</summary>

无。

</details>
