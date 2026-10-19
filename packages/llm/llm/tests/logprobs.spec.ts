/** Persisted probability metadata stays out of model content and follows assembled block positions. */
import { describe, expect, it } from 'vitest'
import { AssistantStreamAccumulator, assistantStreamBlockLogprobs, assembleAssistantStream, expandAssistantStream } from '../src/assistant-stream.ts'
import { ToolCallId } from '../src/brand.ts'
import type { AssistantStreamRecord } from '../src/assistant-stream.ts'
import type { BlockTokenLogprobs, StreamChunk } from '../src/types.ts'

const PROBABILITIES: BlockTokenLogprobs = { tokens: ['a'], logprobs: [-0.1], top: [[{ token: 'b', logprob: -1 }]] }
function records(chunks: StreamChunk[]): readonly AssistantStreamRecord[] {
  const accumulator = new AssistantStreamAccumulator()
  chunks.forEach((chunk, time) => accumulator.push({ time, chunk }))
  return accumulator.snapshot()
}

describe('assistantStreamBlockLogprobs', () => {
  it('round-trips optional block-end data and aligns captures in first-seen block order', () => {
    const stream = records([
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'block-start', index: 9, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 9, text: 'thought' },
      { type: 'block-end', index: 9, block: { type: 'reasoning', text: 'thought' } },
      { type: 'block-start', index: 2, blockType: 'text' },
      { type: 'text-delta', index: 2, text: 'a' },
      { type: 'block-end', index: 2, block: { type: 'text', text: 'a' }, logprobs: PROBABILITIES },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const expanded = expandAssistantStream(JSON.parse(JSON.stringify(stream)) as AssistantStreamRecord[])
    expect(expanded.find(row => row.chunk.type === 'block-end' && row.chunk.index === 2)?.chunk).toMatchObject({ logprobs: PROBABILITIES })
    expect(assembleAssistantStream(stream).blocks()).toEqual([{ type: 'reasoning', text: 'thought' }, { type: 'text', text: 'a' }])
    expect(assistantStreamBlockLogprobs(stream)).toEqual([undefined, PROBABILITIES])
    expect(assistantStreamBlockLogprobs([])).toEqual([])
  })

  it('keeps packed and raw delta positions aligned when max-token truncation drops tool calls', () => {
    const stream = records([
      { type: 'text-delta', index: 1, text: 'a' },
      { type: 'reasoning-delta', index: 3, text: 'thought' },
      { type: 'tool-call-delta', index: 2, id: ToolCallId('call'), name: 'bash', argumentsDelta: '{}' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'a' }, logprobs: PROBABILITIES },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
    expect(assistantStreamBlockLogprobs(stream)).toEqual([PROBABILITIES, undefined])
    const raw = expandAssistantStream(stream).map(row => ({ type: 'chunk' as const, ...row }))
    expect(assistantStreamBlockLogprobs(raw)).toEqual([PROBABILITIES, undefined])
    expect(assistantStreamBlockLogprobs([{ type: 'chunk', time: 0, chunk: { type: 'block-end', index: 5, block: { type: 'text', text: 'a' }, logprobs: PROBABILITIES } }])).toEqual([PROBABILITIES])
  })
})
