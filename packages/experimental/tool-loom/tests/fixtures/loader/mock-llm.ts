/**
 * Test-only `autoloom-mock` route for the autoloom Loader fixture. A request
 * whose first user message starts with `WEAVE ` comes from the weaver: it
 * expands the named story into two children, waits for them, reads the first,
 * keeps it, culls the second, and answers, choosing each step by the number of
 * tool results already in the request and taking the children from the wait. Every other request gets a one-line
 * continuation.
 */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** Text of one message's text blocks. */
function textOf(message: GenerateOptions['messages'][number] | undefined): string {
  return (message?.content ?? []).flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function text(reply: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: reply },
    { type: 'block-end', index: 0, block: { type: 'text', text: reply } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function call(step: number, name: string, args: object): StreamChunk[] {
  const block = { type: 'tool-call' as const, id: ToolCallId(`weave-${String(step)}`), name, arguments: JSON.stringify(args) }
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments },
    { type: 'block-end', index: 0, block },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Scripted weaver and children. */
class AutoloomMockAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const users = options.messages.filter(message => message.role === 'user')
    const first = textOf(users[0])
    if (!first.startsWith('WEAVE ')) {
      yield * text(`next line after: ${textOf(users.at(-1))}`)
      return
    }
    const storyId = first.slice('WEAVE '.length).trim()
    const results = options.messages.filter(message => message.role === 'tool').map(message => textOf(message))
    const expanded = results[0] === undefined ? undefined : JSON.parse(results[0]) as { setId: string }
    // The wait result names every child; the expansion may still hold one queued.
    const waited = results[1] === undefined ? undefined : JSON.parse(results[1]) as { children: { sessionId?: string }[] }
    const ids = waited?.children.flatMap(child => child.sessionId === undefined ? [] : [child.sessionId]) ?? []
    switch (results.length) {
      case 0: yield * call(1, 'loom_expand', { sessionId: storyId, afterTurn: 1, lines: ['darker', 'brighter'] }); return
      case 1: yield * call(2, 'loom_wait', { setId: expanded?.setId }); return
      case 2: yield * call(3, 'loom_read', { sessionId: ids[0] }); return
      case 3: yield * call(4, 'loom_keep', { sessionId: ids[0] }); return
      case 4: yield * call(5, 'loom_cull', { sessionId: ids[1] }); return
      default: yield * text(`kept ${String(ids[0])}`)
    }
  }
}

export const name = 'autoloom-mock-llm'
export const inject = ['llm']

/**
 * Register the `autoloom-mock` adapter.
 * @param ctx - Host context carrying the LLM runtime.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['autoloom-mock'], new AutoloomMockAdapter())
}
