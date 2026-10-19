---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-19-session-continuation

[English](2026-10-19-session-continuation.md) | 中文

## 概述

添加可选的 turn/start 继续归属信息，用于基于现有历史明确请求模型轮次，而不添加用户消息。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-19-session-continuation
baseline: false
changes:
  - root: "event:turn/start"
    previous: "2026-09-11-initial"
    after: "bc47ec0f618cf54a03d2a463139c02e1414c675f8f959e369ef160c9a205f0ea"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

可选的 continuation 字段使用既有 MessageSource 归属词汇，不添加模型可见内容。既有记录保持有效。已发布的 V4 存储事件准入检查事件识别与已移除请求头原因，不要求 turn/start 使用精确键集合。其关系校验器读取 turn/start.data.turn 并忽略额外键；实时追加校验同样读取轮次编号而不拒绝额外 turn/start 键。因此旧 V4 读取器保留归属信息，并解释相同的既有历史与轮次边界。SESSION_FORMAT_VERSION 不变。

<a id="verification"></a>
## 验证

聚焦的 agent、agent-loop、Session Controller 与 TypeScript SDK 投影运行通过 82 个文件中的 1,580 个测试，变更的 Agent 驱动器、继续错误、已消费工作折叠、模型选择监听器、Controller 命令、列表、外观与重试投影均达到 100% 覆盖率。测试覆盖用户及工具结果继续、空历史／忙碌／待处理输入／assistant 末尾拒绝、模型切换通知、pre-step 拒绝、步骤前与 running 状态发布时取消、重试 id、继承 id 排除、投影卸载及非 owner principal 归属。归属包内的 TypeScript 与 Python SDK 期望 JSON 保留继续标记；Python 投影测试也已在本地通过。OpenRouter key 门控的继续测试源码已添加，但尚未运行。所属的已记录会话反事实组合快照与打包 SDK 测试仍由集成人员验证。读取器证据：packages/session/session-persistence/src/storage-contract.ts、packages/session/session-format-v3-to-v4/src/relationships.ts 与 packages/core/session/src/surface.ts。

<a id="dev-note"></a>
## 开发备注

无。
