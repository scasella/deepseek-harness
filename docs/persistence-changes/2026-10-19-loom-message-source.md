---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-19-loom-message-source

English | [中文](2026-10-19-loom-message-source.zh.md)

## Summary

Adds the producer-owned loom message source of autoloom child prompts.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain valid. The loom kind is attribution only: tool-loom writes it on the first prompt a weaver sends to each autoloom child, and the declared source policy preserves unknown attribution without interpreting it, so a reader without tool-loom keeps the message and derives it as an ordinary user message. Provider adapters read only the message content, so the source is not part of any model request. SESSION_FORMAT_VERSION does not change.

<a id="verification"></a>
## Verification

./node_modules/.bin/vitest run packages/experimental/tool-loom packages/experimental/loom/tests/branch-for.host.spec.ts: children of a weaver hold user/message sources { kind: 'loom', weaver, callId } after their branch record and child preset, and every autoloom tool refuses a Session whose first own prompt carries the kind; 32 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
