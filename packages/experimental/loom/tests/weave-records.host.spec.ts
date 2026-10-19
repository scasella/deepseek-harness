/** Durable prose readers reject malformed records and false authorship claims. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { AssistantStreamAccumulator, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { readWeaveDocument, validPrefixSpan } from '../src/weave-records.ts'
import type { LoomNodeId, LoomWeaveNode, LoomWeaveRequestRecord } from '../src/types.ts'

const id = (value: string): LoomNodeId => brandString<LoomNodeId>(value)
function stream(chunks = textResponse('A')) {
  const value = new AssistantStreamAccumulator()
  for (const chunk of chunks) value.push({ time: 0, chunk })
  return value.snapshot()
}
function request(session: Session, overrides: Record<string, unknown> = {}) {
  const value: LoomWeaveRequestRecord = {
    version: 1, parentNode: null, n: 1, config: { provider: 'mock', model: 'mock' }, topLogprobs: 0,
    system: 'Prose', messages: [{ role: 'user', content: [{ type: 'text', text: 'Continue' }] }],
    assistantPrefix: '', prefixSpans: [], stop: [], schedule: 'burst', kind: 'weave',
  }
  return appendPluginRecord(session, 'plugin:loom/weave-request', { ...value, ...overrides })
}
function node(session: Session, requestSeq: SessionSeq, overrides: Record<string, unknown> = {}) {
  return appendPluginRecord(session, 'plugin:loom/weave-node', {
    version: 1, id: id('node'), requestSeq, index: 0, kind: 'weave', stream: stream(), ...overrides,
  } as never)
}
function choice(session: Session, requestSeq: SessionSeq, overrides: Record<string, unknown> = {}) {
  return appendPluginRecord(session, 'plugin:loom/choice', {
    version: 1, nodeId: id('node'), requestSeq, alternatives: 1, ...overrides,
  } as never)
}

describe('persisted prose records', () => {
  it('orders changed choices after choices from other sibling sets', () => {
    const session = Session.create(SessionId('choice-order'))
    const first = request(session, { n: 2 })
    node(session, first, { id: id('first-a') })
    node(session, first, { id: id('first-b'), index: 1 })
    const second = request(session)
    node(session, second, { id: id('second') })
    choice(session, first, { nodeId: id('first-a'), alternatives: 2 })
    choice(session, second, { nodeId: id('second') })
    choice(session, first, { nodeId: id('first-b'), alternatives: 2 })
    const state = readWeaveDocument(session.snapshotEvents()).state
    expect(state.choices.map(value => value.nodeId)).toEqual(['second', 'first-b'])
    expect(state.curationBits).toBe(1)
  })

  it.each([
    { version: 2 }, { parentNode: 'missing' }, { assistantPrefix: 'unattributed' },
    { assistantPrefix: 'A', prefixSpans: [{ text: 'A', author: 'model', node: 'missing' }] },
  ])('ignores invalid request records: %j', (override) => {
    const session = Session.create(SessionId('invalid-request'))
    node(session, request(session, override))
    expect(readWeaveDocument(session.snapshotEvents()).state.nodes).toEqual([])
  })

  it.each([
    { version: 2 }, { requestSeq: SessionSeq(999) }, { index: 1 }, { kind: 'probe' },
    { stream: [{ type: 'invalid' }] },
    { stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish' } }] },
    { stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'error' } } }] },
    { stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 'invalid' } } }] },
    { stream: [{ type: 'chunk', time: 0, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'A' },
      logprobs: { tokens: ['A'], logprobs: [0], top: [[{ token: 'A', logprob: 'invalid' }]] },
    } }] },
  ])('ignores invalid sibling records: %j', (override) => {
    const session = Session.create(SessionId('invalid-node'))
    node(session, request(session), override)
    expect(readWeaveDocument(session.snapshotEvents()).state.nodes).toEqual([])
  })

  it('keeps only one node per identity and per request position', () => {
    const session = Session.create(SessionId('duplicate-node'))
    const seq = request(session, { n: 2 })
    node(session, seq)
    node(session, seq, { index: 1 })
    node(session, seq, { id: id('other') })
    expect(readWeaveDocument(session.snapshotEvents()).state.nodes.map(value => value.id)).toEqual(['node'])
  })

  it.each([
    { version: 2 }, { nodeId: id('missing') }, { requestSeq: SessionSeq(999) }, { alternatives: 2 },
  ])('gives no curation credit to invalid choices: %j', (override) => {
    const session = Session.create(SessionId('invalid-choice'))
    const seq = request(session)
    node(session, seq)
    choice(session, seq, override)
    expect(readWeaveDocument(session.snapshotEvents()).state.choices).toEqual([])
  })

  it('retains incomplete and tool-call settlements as failed, without choice credit', () => {
    const session = Session.create(SessionId('failed-node'))
    const seq = request(session)
    node(session, seq, { stream: [] })
    choice(session, seq)
    expect(readWeaveDocument(session.snapshotEvents()).state).toMatchObject({
      nodes: [{ status: 'failed', error: 'Prose generation did not finish with text.' }], choices: [],
    })
    const probe = request(session, { kind: 'probe' })
    node(session, probe, { id: id('probe'), kind: 'probe' })
    choice(session, probe, { nodeId: id('probe') })
    expect(readWeaveDocument(session.snapshotEvents()).state.choices).toEqual([])
  })

  it('uses provider output usage when captures are absent and zero when usage is absent', () => {
    const session = Session.create(SessionId('uncaptured-node'))
    const first = request(session)
    node(session, first)
    choice(session, first)
    const second = request(session)
    node(session, second, { id: id('zero'), stream: stream(textResponse('A').filter(chunk => chunk.type !== 'usage')) })
    choice(session, second, { nodeId: id('zero') })
    appendPluginRecord(session, 'plugin:loom/mark', { version: 1, mark: 'keep' })
    expect(readWeaveDocument(session.snapshotEvents()).state).toMatchObject({ modelTokens: 1, curationBits: 0 })
  })

  it('omits incomplete probability coverage instead of shading uncaptured text', () => {
    const session = Session.create(SessionId('partial-capture'))
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'A' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'A' }, logprobs: { tokens: ['A'], logprobs: [-1], top: [[]] } },
      { type: 'block-start', index: 1, blockType: 'text' }, { type: 'text-delta', index: 1, text: 'B' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'B' } }, { type: 'finish', reason: { kind: 'stop' } },
    ]
    node(session, request(session), { stream: stream(chunks) })
    expect(readWeaveDocument(session.snapshotEvents()).state.nodes[0]?.logprobs).toBeUndefined()
  })

  it('validates exact model substrings and source alternatives', () => {
    const recorded: LoomWeaveNode = {
      id: id('source'), parent: null, requestSeq: SessionSeq(0), index: 0, kind: 'weave', prefix: [], text: 'AB', status: 'completed',
      logprobs: { tokens: ['A'], logprobs: [-1], top: [[{ token: 'B', logprob: -2 }]] },
    }
    expect(validPrefixSpan({ text: 'A', author: 'model', node: recorded.id }, [recorded])).toBe(true)
    expect(validPrefixSpan({ text: 'C', author: 'model', node: recorded.id }, [recorded])).toBe(false)
    expect(validPrefixSpan({ text: 'A', author: 'model', node: recorded.id, tokenIndex: 0 }, [recorded])).toBe(false)
    expect(validPrefixSpan({ text: 'A', author: 'user', tokenIndex: 0 }, [recorded])).toBe(false)
    expect(validPrefixSpan({ text: 'B', author: 'alternative', node: recorded.id }, [recorded])).toBe(false)
    expect(validPrefixSpan({ text: 'B', author: 'alternative', node: recorded.id, tokenIndex: 9 }, [recorded])).toBe(false)
    expect(validPrefixSpan({ text: 'B', author: 'alternative', node: recorded.id, tokenIndex: 0 }, [{ ...recorded, logprobs: undefined } as never])).toBe(false)
    expect(validPrefixSpan({ text: 'C', author: 'alternative', node: recorded.id, tokenIndex: 0 }, [recorded])).toBe(false)
  })
})
