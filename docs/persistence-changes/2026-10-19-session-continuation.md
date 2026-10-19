---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-19-session-continuation

English | [中文](2026-10-19-session-continuation.zh.md)

## Summary

Adds optional turn/start continuation attribution for an explicit model turn over existing history without a new user message.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The optional continuation field carries the existing MessageSource attribution vocabulary and adds no model-visible content. Existing records remain valid. Released V4 stored-event admission checks event recognition and retired request-header reasons without requiring exact turn/start keys. Its relationship validator reads turn/start.data.turn and ignores extra keys; live append validation likewise reads the turn number without rejecting extra turn/start keys. Older V4 readers therefore retain the attribution and interpret the same existing history and turn boundaries. SESSION_FORMAT_VERSION remains unchanged.

<a id="verification"></a>
## Verification

The focused agent, agent-loop, Session Controller and TypeScript SDK projection run passes 1,580 tests across 82 files, with 100% coverage of the changed Agent driver, continuation error, consumed-work fold, model-selection listeners, Controller commands, list, facade and retry projection. Tests cover user and tool-result continuation, empty/busy/pending/assistant-tail refusal, model-switch notices, pre-step rejection, cancellation before a step and during running-status publication, retry ids, inherited-id exclusion, projection unload, and non-owner principal attribution. Owner-local TypeScript and Python SDK expected JSON retain the continuation marker; the Python projection test also passes locally. The OpenRouter-gated continuation test source exists but has not been run. The owning recorded-session counterfactual composition snapshot and packaged SDK lanes remain integrator verification. Reader evidence: packages/session/session-persistence/src/storage-contract.ts, packages/session/session-format-v3-to-v4/src/relationships.ts, and packages/core/session/src/surface.ts.

<a id="dev-note"></a>
## Dev Note

None.
