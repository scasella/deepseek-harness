---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-19-token-probabilities

English | [中文](2026-10-19-token-probabilities.zh.md)

## Summary

Assistant stream block-end chunks optionally retain generation-time token log probabilities, and request headers optionally retain the topLogprobs capture control.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Same Session format version: no StreamChunk discriminator changes. Released dsh-v0.2.0-rc.2 assistant-stream validateRecord checks raw record keys and lossless JSON but does not reject additional chunk properties; its BlockAssembler block-end case reads only chunk.block. Recorded message content therefore stays identical, including the JSONL generation content-equality check. The released Session request-header seed validator checks provider/model, reasoning effort and adapter defaults without rejecting additional config keys, and its callConfigEquals compares only known fields, so topLogprobs is safely ignored. Raw chunk pass-through in released Python expansion and the format row decoders is documented in loom-handoff/maps/05-llm-loop.md section 1.2; direct git-show verification also checked the released raw-record, block-end, request-header and equality implementations. Probability data is optional metadata and never enters model-facing content.

<a id="verification"></a>
## Verification

The focused keyless LLM/pi-ai/replay lane passed 36 files and 875 tests with 100% per-file statements, branches, functions and lines across all changed runtime modules. New specs cover compact-stream probability round trips, text alignment, max-token tool-call removal, probability capability limits, prepared and unprepared prefix refusals, actual pi-ai raw SSE hooks, missing/malformed or byte-split capture omission, both prefix payload modes, and weave replay ordering. Full replay corpus and OpenRouter live suites remain integrator-owned and are not claimed here.

<a id="dev-note"></a>
## Dev Note

None.
