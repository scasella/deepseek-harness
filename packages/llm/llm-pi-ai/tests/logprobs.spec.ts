/** Raw SSE probability samples are paired with text deltas and rejected when incomplete or misaligned. */
import { describe, expect, it, vi } from 'vitest'
import { TokenLogprobCapture } from '../src/logprobs.ts'
import { markDeepSeekPrefix } from '../src/prefix.ts'

function raw(content: string | null, logprobs?: unknown) {
  return { choices: [{ delta: { content }, logprobs }] }
}
function token(text: string, logprob = -0.1) { return { token: text, logprob } }

describe('TokenLogprobCapture', () => {
  it('joins FIFO samples and normalizes unknown sampled probabilities without fabricating alternatives', () => {
    const degrade = vi.fn()
    const capture = new TokenLogprobCapture(degrade)
    for (const ignored of [null, {}, { choices: [] }, { choices: [{ delta: {} }] }, raw(null), raw('')]) capture.observe(ignored)
    capture.observe(raw('a', { content: [{ ...token('a'), top_logprobs: [token('a'), token('z', -9999)] }] }))
    capture.observe(raw('b', { content: [token('b', -9999)] }))
    capture.delta(4)
    capture.delta(4)
    expect(capture.finish(4, 'ab')).toEqual({ tokens: ['a', 'b'], logprobs: [-0.1, null], top: [[token('a')], []] })
    expect(degrade).not.toHaveBeenCalled()
  })

  it('keeps a missing or malformed sample in its FIFO position and leaves other blocks readable', () => {
    const degrade = vi.fn()
    const capture = new TokenLogprobCapture(degrade)
    capture.observe(raw('a', { content: [{ token: 'a', logprob: 'bad' }] }))
    capture.observe(raw('b', { content: [token('b')] }))
    capture.delta(0)
    capture.delta(1)
    expect(capture.finish(0, 'a')).toBeUndefined()
    expect(capture.finish(1, 'b')?.tokens).toEqual(['b'])
    capture.observe(raw('c', { content: null }))
    capture.delta(2)
    expect(capture.finish(2, 'c')).toBeUndefined()
    expect(capture.finish(9, '')).toBeUndefined()
    expect(degrade).toHaveBeenCalledTimes(3)
  })

  it('omits byte-split multibyte tokens whose token strings do not reproduce the text', () => {
    const degrade = vi.fn()
    const capture = new TokenLogprobCapture(degrade)
    capture.observe(raw('你', { content: [{ ...token('�'), bytes: [228, 189] }, { ...token('�'), bytes: [160] }] }))
    capture.delta(0)
    expect(capture.finish(0, '你')).toBeUndefined()
    expect(degrade).toHaveBeenCalledWith('token text does not match the completed block')
  })
})

describe('DeepSeek beta prefixes', () => {
  it('preserves all body fields while marking only the last assistant message and dropping its reasoning prefix', () => {
    const payload = { model: 'm', stream: true, messages: [{ role: 'user', content: 'story' }, { role: 'assistant', content: 'Once', reasoning_content: '' }] }
    expect(markDeepSeekPrefix(payload, 'Once')).toEqual({ model: 'm', stream: true, messages: [{ role: 'user', content: 'story' }, { role: 'assistant', content: 'Once', prefix: true }] })
    expect(payload.messages[1]).toHaveProperty('reasoning_content')
  })
  it('fails before dispatch if serialization lost or changed the final assistant text', () => {
    for (const payload of [null, {}, { messages: [] }, { messages: [{ role: 'user', content: 'Once' }] }, { messages: [{ role: 'assistant', content: 'Other' }] }]) {
      expect(() => markDeepSeekPrefix(payload, 'Once')).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }))
    }
  })
})
