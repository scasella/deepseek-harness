/** Chat-owned event-to-view projection. */

import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-api-remotes/client'
import {
  displayFailure, emptyAssistantBlock, toAssistantBlock, toAssistantBlocks,
  isTokenDelta,
} from '../src/client/conversation-nodes/event-projection.ts'

describe('toAssistantBlock', () => {
  it('carries captured probabilities on text blocks at their assembled positions', () => {
    const logprobs = { tokens: ['answer'], logprobs: [-0.1], top: [[]] }
    const content: ContentBlock[] = [{ type: 'reasoning', text: 'thought' }, { type: 'text', text: 'answer' }]
    expect(toAssistantBlocks(content, [undefined, logprobs])).toEqual([
      { kind: 'reasoning', text: 'thought' }, { kind: 'text', text: 'answer', logprobs },
    ])
    expect(toAssistantBlock(content[0] as ContentBlock, logprobs)).toEqual({ kind: 'reasoning', text: 'thought' })
  })
  it('classifies the four block shapes', () => {
    const attachment = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png' as const,
      bytes: 68,
      width: 1,
      height: 1,
    }
    const blocks: ContentBlock[] = [
      { type: 'text', text: '正文' },
      { type: 'reasoning', text: '思考' },
      { type: 'tool-call', id: 'c1', name: 'echo', arguments: '{}' } as ContentBlock,
      { type: 'image', attachment },
    ]
    expect(toAssistantBlocks(blocks)).toEqual([
      { kind: 'text', text: '正文' },
      { kind: 'reasoning', text: '思考' },
      { kind: 'tool-call', callId: 'c1', name: 'echo', argsRaw: '{}' },
      { kind: 'image', attachment },
    ])
    expect(toAssistantBlock(blocks[0] as ContentBlock)).toEqual({ kind: 'text', text: '正文' })
    expect(toAssistantBlock({ type: 'future' } as unknown as ContentBlock))
      .toEqual({ kind: 'other', block: { type: 'future' } })
  })

  it('creates empty streamed block projections', () => {
    expect(emptyAssistantBlock('text')).toEqual({ kind: 'text', text: '' })
    expect(emptyAssistantBlock('reasoning')).toEqual({ kind: 'reasoning', text: '' })
    expect(emptyAssistantBlock('tool-call')).toEqual({ kind: 'tool-call', callId: '', name: '', argsRaw: '' })
    expect(emptyAssistantBlock('future')).toEqual({ kind: 'other', block: null })
  })

  it('redacts auth failures and presents the remaining durable values', () => {
    expect(displayFailure({ code: 'AUTH', message: 'secret' })).toEqual({ code: 'AUTH', message: '' })
    expect(displayFailure({ code: 'TRANSPORT', message: 'offline' }))
      .toEqual({ code: 'TRANSPORT', message: 'offline' })
    expect(displayFailure({ code: 'UNKNOWN' })).toEqual({ code: 'UNKNOWN', message: '{"code":"UNKNOWN"}' })
    expect(displayFailure(null)).toEqual({ message: 'null' })
  })

  it('recognizes only non-empty token deltas', () => {
    expect(isTokenDelta({ type: 'text-delta', index: 0, text: 'x' } as never)).toBe(true)
    expect(isTokenDelta({ type: 'reasoning-delta', index: 0, text: '' } as never)).toBe(false)
    expect(isTokenDelta({ type: 'tool-call-delta', index: 0, id: 'c', argumentsDelta: '', name: 'tool' } as never)).toBe(true)
    expect(isTokenDelta({ type: 'tool-call-delta', index: 0, id: 'c', argumentsDelta: '' } as never)).toBe(false)
    expect(isTokenDelta({ type: 'finish', reason: 'stop' } as never)).toBe(false)
  })
})
