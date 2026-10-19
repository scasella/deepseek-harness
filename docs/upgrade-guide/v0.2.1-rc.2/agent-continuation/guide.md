---
kind: upgrade-guide
description: "Custom Agent providers must implement message-free continuation through the required Agent.continue method."
---

# Custom Agent providers implement continuation

English | [中文](guide.zh.md)

## Change

The published `Agent` interface now requires `continue(source?: MessageSource): void`. A custom driver registered through `AgentRegistry.setFactory()` must implement it; implementations that omit it no longer typecheck. The method opens a model turn over existing history without adding a user message. The shipped `dsh-agent-loop` implements it. Factory callers, configuration, and SDK protocol verbs require no change.

## Migration

1. Add `continue(source?: MessageSource): void` to your custom `Agent` implementation. Import `MessageSource` from `@deepseek-ai/dsh-llm` and `AgentContinuationError` from `@deepseek-ai/dsh-agent`. Default an omitted source to `{ kind: 'user' }`.
2. Before mutating history or queues, require actual idle with no maintenance task, both inbox queues empty, every retained tool call answered, and a user or tool result as the latest conversational message. Reject with the corresponding `AgentContinuationError.reason`: `busy`, `pending-input`, `pending-tools`, `empty-history`, or `assistant-tail`. This operation does not supply an assistant prefix.
3. Record the accepted source in `turn/start.continuation` and expose it on the first `agent/pre-step` payload. Permit the first admitted step without a new inbox message while retaining normal rejection, cancellation, and request policies. Follow the [Agent continuation reference](../../../../packages/core/agent/README.md) and [persistence acknowledgement](../../../persistence-changes/2026-10-19-session-continuation.md).
4. Typecheck your provider and test both admission and every refusal. Verify that refusal changes neither history nor queues, an accepted request records its continuation source, and no user message is inserted. The shipped loop's reference cases are in [continuation.spec.ts](../../../../packages/core/agent-loop/tests/continuation.spec.ts).
