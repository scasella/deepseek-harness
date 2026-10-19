/**
 * Test-only `loom-mock` route for the Loom Loader fixture. It answers every
 * request and logs each agent-loop request, as `llm/stream` listeners receive
 * it before route projection, as one JSONL line in the working directory.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { REQUEST_LOG, type LoggedRequest } from './files.ts'

/** Deterministic one-step adapter whose reply counts the calls it answered. */
class LoomMockAdapter extends LlmAdapter {
  private count = 0

  async * stream(): AsyncIterable<StreamChunk> {
    this.count += 1
    const text = `loom reply ${String(this.count)}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'loom-mock-llm'
export const inject = ['llm']

/**
 * Register the `loom-mock` adapter and the request log.
 * @param ctx - Host context carrying the LLM runtime.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['loom-mock'], new LoomMockAdapter())
  ctx.on('llm/stream', (options, next) => {
    if (isAgentLoopRequest(options)) {
      const logged: LoggedRequest = {
        sessionId: options.sessionId,
        provider: options.provider,
        model: options.model,
        toolNames: (options.tools ?? []).map(tool => tool.name),
        messages: options.messages,
      }
      appendFileSync(join(process.cwd(), REQUEST_LOG), `${JSON.stringify(logged)}\n`)
    }
    return next()
  })
}
