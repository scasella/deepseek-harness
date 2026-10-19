---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-19-token-probabilities

[English](2026-10-19-token-probabilities.md) | 中文

## 概述

Assistant 流的 block-end 分片可选地保留生成时的 token 对数概率，请求头可选地保留 topLogprobs 捕获控制。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-19-token-probabilities
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "b5797bbd8cf6534a2a9a585635ffde4cfd5338de2b304886e57de3a0710164f9"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "69cd086d4aab0d3946c516223b31abaaa227175aee75d05f775f536eba332b40"
    decision: same-version
  - root: "event:request/header"
    previous: "2026-09-16-session-format-v4"
    after: "23e458726444cf0351eeed0cda60b574ae097a625a133ab3eb4b82d866346dce"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

保持相同 Session 格式版本：不更改任何 StreamChunk 判别值。已发布的 dsh-v0.2.0-rc.2 中，assistant-stream 的 validateRecord 检查原始记录键和无损 JSON，但不拒绝额外的 chunk 属性；其 BlockAssembler 的 block-end 分支只读取 chunk.block。因此记录的消息内容保持相同，包括 JSONL generation 的内容相等检查。已发布 Session 请求头 seed 校验器检查 provider/model、推理强度与适配器默认值，不拒绝额外配置键；其 callConfigEquals 只比较已知字段，因此可安全忽略 topLogprobs。已发布 Python 展开和格式行解码器对原始分片的透传证据记录于 loom-handoff/maps/05-llm-loop.md 第 1.2 节；另用 git-show 直接核对了已发布的原始记录、block-end、请求头和相等比较实现。概率数据是可选元数据，不进入面向模型的内容。

<a id="verification"></a>
## 验证

针对性的无密钥 LLM/pi-ai/replay 测试通过 36 个文件、875 个测试，所有更改的运行时模块逐文件语句、分支、函数和行覆盖率均为 100%。新测试覆盖紧凑流概率往返、文本对齐、达到 token 上限时移除工具调用、概率能力限制、已准备和未准备调用的前缀拒绝、真实 pi-ai 原始 SSE hook、缺失/格式错误或字节拆分捕获的省略、两种前缀请求体，以及 weave 回放顺序。完整回放语料与 OpenRouter 实时测试仍由集成方负责，此处不声称已运行。

<a id="dev-note"></a>
## 开发备注

无。
