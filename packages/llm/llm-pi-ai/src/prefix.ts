/** DeepSeek beta prefix marking after pi-ai has serialized the trailing assistant message. */
import { LlmError } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'

const payloadSchema = z.looseObject({ messages: z.array(z.record(z.string(), z.unknown())) })

/**
 * Mark the final assistant text as a DeepSeek prefix without enabling a reasoning prefix.
 * @param payload - pi-ai's request body.
 * @param prefix - exact requested assistant text.
 * @returns the body with only its final message replaced.
 * @throws LlmError `INVALID_REQUEST` when serialization did not preserve the final assistant prefix.
 */
export function markDeepSeekPrefix(payload: unknown, prefix: string): unknown {
  const parsed = payloadSchema.safeParse(payload)
  const last = parsed.success ? parsed.data.messages.at(-1) : undefined
  if (last?.['role'] !== 'assistant' || last['content'] !== prefix || !parsed.success) {
    throw new LlmError('pi-ai serialization did not preserve the final assistant prefix', 'INVALID_REQUEST')
  }
  const { reasoning_content: _reasoning, ...message } = last
  return { ...parsed.data, messages: [...parsed.data.messages.slice(0, -1), { ...message, prefix: true }] }
}
