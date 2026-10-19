---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-19-loom-message-source

[English](2026-10-19-loom-message-source.md) | 中文

## 概述

新增由生产方拥有的 loom 消息来源，用于 autoloom 子会话的提示。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-19-loom-message-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "76c5a437474218ded1600c9b9a4efe042dfa8633dffb24da65c6ad5fe8967d7b"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "12b14262d77dc02f87be039b1eab4aa0d272089b3ba7852f2ad15a402048f15b"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "3f13771469503fe989d1315700b759aec8fc900cdd52abac814801439cdeface"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "ae9127b684313154660c05f36d4d4729493624f76da28d4acb4bf00fce61c4b8"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效。loom 种类仅用于归属：tool-loom 在 weaver 发给每个 autoloom 子会话的首个提示上写入它，而已声明的来源策略会保留未知归属且不解释它，因此没有 tool-loom 的读取方会保留该消息，并把它当作普通用户消息推导。提供方适配器只读取消息内容，因此来源不属于任何模型请求。SESSION_FORMAT_VERSION 不变。

<a id="verification"></a>
## 验证

./node_modules/.bin/vitest run packages/experimental/tool-loom packages/experimental/loom/tests/branch-for.host.spec.ts：weaver 的子会话在分支记录和子会话预设之后持有 user/message 来源 { kind: 'loom', weaver, callId }，且每个 autoloom 工具都拒绝首个自有提示带有该种类的 Session；32 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
