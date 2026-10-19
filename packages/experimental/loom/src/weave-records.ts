/** Validated prose document reconstruction from ignorable Loom records. */
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  assistantStreamBlockLogprobs, expandAssistantStream, joinAssistantStreamText, lastAssistantStreamChunk,
  type AssistantStreamRecord, type BlockTokenLogprobs,
} from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { LoomChoiceRecord, LoomNodeId, LoomPrefixSpan, LoomWeaveNode, LoomWeaveState } from './types.ts'

const nodeId = z.string().min(1).transform(value => brandString<LoomNodeId>(value))
const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq)
const prefixSpan = z.object({
  text: z.string(), author: z.enum(['user', 'model', 'alternative']),
  node: nodeId.exactOptional(), tokenIndex: z.number().int().nonnegative().exactOptional(),
})
const requestSchema = z.object({
  version: z.literal(1), parentNode: nodeId.nullable(), n: z.number().int().positive(),
  kind: z.enum(['weave', 'probe']), assistantPrefix: z.string(), prefixSpans: z.array(prefixSpan),
  config: z.object({ provider: z.string().min(1), model: z.string().min(1) }),
  system: z.string(), messages: z.array(z.object({ role: z.literal('user'), content: z.array(z.object({ type: z.literal('text'), text: z.string() })) })),
  topLogprobs: z.number().int().min(0).max(20), stop: z.array(z.string()), schedule: z.enum(['lead-then-burst', 'burst']),
})
const nodeSchema = z.object({
  version: z.literal(1), id: nodeId, requestSeq: seq, index: z.number().int().nonnegative(),
  kind: z.enum(['weave', 'probe']), stream: z.array(z.custom<AssistantStreamRecord>()),
})
const choiceSchema: z.ZodType<LoomChoiceRecord> = z.object({
  version: z.literal(1), nodeId, requestSeq: seq, alternatives: z.number().int().positive(),
})
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const probability = z.number().max(0)
const captureSchema = z.object({
  tokens: z.array(z.string()), logprobs: z.array(probability.nullable()),
  top: z.array(z.array(z.object({ token: z.string(), logprob: probability }))),
}).refine(value => value.tokens.length === value.logprobs.length && value.tokens.length === value.top.length)
const contentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  z.object({ type: z.literal('tool-call'), id: z.string(), name: z.string(), arguments: z.string() }),
])
const failureSchema = z.object({ code: z.string(), message: z.string() })
const chunkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('block-start'), index: count, blockType: z.enum(['text', 'reasoning', 'tool-call']) }),
  z.object({ type: z.enum(['text-delta', 'reasoning-delta']), index: count, text: z.string() }),
  z.object({ type: z.literal('tool-call-delta'), index: count, id: z.string(), name: z.string().exactOptional(), argumentsDelta: z.string() }),
  z.object({ type: z.literal('block-end'), index: count, block: contentSchema, logprobs: captureSchema.exactOptional() }),
  z.object({ type: z.literal('usage'), usage: z.object({ inputTokens: count, outputTokens: count,
    totalTokens: count.exactOptional(), cacheReadTokens: count.exactOptional(),
    cacheWriteTokens: count.exactOptional(), reasoningTokens: count.exactOptional(),
  }) }),
  z.object({ type: z.literal('finish'), reason: z.discriminatedUnion('kind', [
    z.object({ kind: z.enum(['stop', 'tool-calls', 'max-tokens']) }),
    z.object({ kind: z.enum(['error', 'aborted']), failure: failureSchema }),
  ]) }),
])

/** Parsed request fields needed for document navigation and prefix attribution. */
export type LoomStoredWeaveRequest = z.infer<typeof requestSchema>

/** The document plus its validated auxiliary request records. */
export interface LoomWeaveDocument {
  readonly state: LoomWeaveState
  readonly requests: ReadonlyMap<SessionSeq, LoomStoredWeaveRequest>
}

/**
 * Validate one authored span against recorded text or captured alternatives.
 * @param span - prefix fragment to attribute.
 * @param nodes - prior recorded prose nodes.
 * @returns whether the declared author and source match the fragment.
 */
export function validPrefixSpan(span: LoomPrefixSpan, nodes: readonly LoomWeaveNode[]): boolean {
  const node = span.node === undefined ? undefined : nodes.find(value => value.id === span.node)
  if (span.author === 'user') return span.node === undefined && span.tokenIndex === undefined
  if (span.author === 'model') return node !== undefined && span.tokenIndex === undefined && node.text.includes(span.text)
  return node !== undefined && span.tokenIndex !== undefined
    && node.logprobs?.top[span.tokenIndex]?.some(value => value.token === span.text) === true
}

/**
 * Assemble a settled node from a validated compact stream.
 * @param record - sibling identity and recorded chunks.
 * @param request - validated auxiliary request fields.
 * @returns the node, or undefined when the compact stream is malformed.
 */
function nodeFromRecord(record: z.infer<typeof nodeSchema>, request: LoomStoredWeaveRequest): LoomWeaveNode | undefined {
  try {
    const chunks = expandAssistantStream(record.stream)
    if (chunks.some(value => !chunkSchema.safeParse(value.chunk).success)) return undefined
    const finish = lastAssistantStreamChunk(record.stream, 'finish')?.reason
    const usage = lastAssistantStreamChunk(record.stream, 'usage')?.usage
    const captures = assistantStreamBlockLogprobs(record.stream)
    const captured = captures.filter((value): value is BlockTokenLogprobs => value !== undefined)
    const text = joinAssistantStreamText(record.stream)
    const logprobs: BlockTokenLogprobs | undefined = captured.length > 0 && captured.length === captures.length
      ? {
        tokens: captured.flatMap(value => value.tokens),
        logprobs: captured.flatMap(value => value.logprobs),
        top: captured.flatMap(value => value.top),
      }
      : undefined
    const status = finish?.kind === 'stop' || finish?.kind === 'max-tokens' ? 'completed'
      : finish?.kind === 'aborted' ? 'cancelled' : 'failed'
    const error = finish?.kind === 'error' || finish?.kind === 'aborted' ? finish.failure.message
      : status === 'failed' ? 'Prose generation did not finish with text.' : undefined
    return {
      id: record.id, parent: request.parentNode, requestSeq: record.requestSeq, index: record.index,
      kind: request.kind, prefix: request.prefixSpans, text, status,
      ...usage === undefined ? {} : { usage },
      ...logprobs === undefined || logprobs.tokens.join('') !== text ? {} : { logprobs },
      ...error === undefined ? {} : { error },
      ...finish?.kind === 'error' || finish?.kind === 'aborted' ? { failureCode: finish.failure.code } : {},
    }
  } catch (_invalidStream) {
    // Ignorable experimental records with invalid streams supply no document node.
    return undefined
  }
}

/**
 * Reconstruct the prose document without changing the Chat surface. Malformed
 * or unknown-version ignorable records supply no nodes or curation credit.
 * @param events - complete Session event sequence.
 * @returns nodes in request/index order and the latest choice in each set.
 */
export function readWeaveDocument(events: readonly SessionEvent[]): LoomWeaveDocument {
  const requests = new Map<SessionSeq, LoomStoredWeaveRequest>()
  const nodes = new Map<LoomNodeId, LoomWeaveNode>()
  const positions = new Set<string>()
  const choices = new Map<SessionSeq, LoomChoiceRecord>()
  for (const event of events) {
    const record = pluginRecordOf(event)
    if (record?.type === 'plugin:loom/weave-request') {
      const request = requestSchema.safeParse(record.data).data
      if (request !== undefined && (request.parentNode === null || nodes.has(request.parentNode))
        && request.prefixSpans.map(span => span.text).join('') === request.assistantPrefix
        && request.prefixSpans.every(span => validPrefixSpan(span, [...nodes.values()]))) requests.set(event.seq, request)
    } else if (record?.type === 'plugin:loom/weave-node') {
      const parsed = nodeSchema.safeParse(record.data).data
      const request = parsed === undefined ? undefined : requests.get(parsed.requestSeq)
      if (parsed === undefined || request === undefined || parsed.index >= request.n || parsed.kind !== request.kind
        || nodes.has(parsed.id) || positions.has(`${String(parsed.requestSeq)}:${String(parsed.index)}`)) continue
      const node = nodeFromRecord(parsed, request)
      if (node !== undefined) { nodes.set(node.id, node); positions.add(`${String(parsed.requestSeq)}:${String(parsed.index)}`) }
    } else if (record?.type === 'plugin:loom/choice') {
      const choice = choiceSchema.safeParse(record.data).data
      const node = choice === undefined ? undefined : nodes.get(choice.nodeId)
      if (choice === undefined || node === undefined || node.kind !== 'weave' || node.status !== 'completed'
        || node.requestSeq !== choice.requestSeq) continue
      const alternatives = [...nodes.values()].filter(value => value.requestSeq === choice.requestSeq && value.status === 'completed').length
      if (choice.alternatives === alternatives) {
        choices.delete(choice.requestSeq)
        choices.set(choice.requestSeq, choice)
      }
    }
  }
  const selected = [...choices.values()]
  return {
    requests,
    state: {
      nodes: [...nodes.values()].sort((left, right) => left.requestSeq - right.requestSeq || left.index - right.index),
      choices: selected,
      curationBits: selected.reduce((total, choice) => total + Math.log2(choice.alternatives), 0),
      modelTokens: selected.reduce((total, choice) => {
        const chosen = nodes.get(choice.nodeId)
        return total + (chosen?.logprobs?.tokens.length ?? chosen?.usage?.outputTokens ?? 0)
      }, 0),
    },
  }
}
