---
kind: upgrade-guide
description: "自定义 Agent 提供方必须通过新增的必需方法 Agent.continue 实现无新消息的继续。"
---

# 自定义 Agent 提供方实现继续

[English](guide.md) | 中文

## 变更

已发布的 `Agent` 接口现在要求 `continue(source?: MessageSource): void`。通过 `AgentRegistry.setFactory()` 注册的自定义驱动器必须实现它；省略该方法的实现不再通过类型检查。该方法基于现有历史开启模型轮次，不添加用户消息。随附的 `dsh-agent-loop` 已实现它。工厂调用方、配置与 SDK 协议动词无需更改。

## 迁移

1. 在自定义 `Agent` 实现中添加 `continue(source?: MessageSource): void`。从 `@deepseek-ai/dsh-llm` 导入 `MessageSource`，从 `@deepseek-ai/dsh-agent` 导入 `AgentContinuationError`。省略 source 时默认为 `{ kind: 'user' }`。
2. 修改历史或队列之前，要求实际空闲且没有维护任务、两个 inbox 队列为空、每个保留的工具调用都有结果，且最后一条对话消息为用户消息或工具结果。使用对应的 `AgentContinuationError.reason` 拒绝：`busy`、`pending-input`、`pending-tools`、`empty-history` 或 `assistant-tail`。此操作不提供 assistant 前缀。
3. 将被接纳的 source 记录在 `turn/start.continuation` 中，并在首个 `agent/pre-step` payload 中公开它。允许首个被接纳的步骤没有新的 inbox 消息，同时保留正常的拒绝、取消与请求策略。遵循 [Agent 继续参考](../../../../packages/core/agent/README.zh.md)和[持久化确认记录](../../../persistence-changes/2026-10-19-session-continuation.zh.md)。
4. 对提供方运行类型检查，并测试准入及每一种拒绝。验证拒绝不改变历史或队列、被接纳的请求记录继续来源，且没有插入用户消息。随附循环的参考用例见 [continuation.spec.ts](../../../../packages/core/agent-loop/tests/continuation.spec.ts)。
