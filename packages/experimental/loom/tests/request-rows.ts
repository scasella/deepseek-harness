/** Message rows of a `LoomRequestView` that a logged request determines on its own. */
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import { messageText, previewOf } from '../src/request-at.ts'

/**
 * Map logged request messages to the role, preview, and length fields of view rows.
 * @param messages - messages of one request the agent loop sent.
 * @returns one row per message, in request order.
 */
export function requestRows(messages: readonly RequestMessage[]): { role: string; preview: string; chars: number }[] {
  return messages.map((message) => {
    const text = messageText(message)
    return { role: message.role === 'developer' ? 'system' : message.role, preview: previewOf(text), chars: Array.from(text).length }
  })
}
