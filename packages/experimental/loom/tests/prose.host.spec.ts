/** Logged auxiliary prose, authored prefixes, choices, bounded probes and lifecycle settlement. */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AssistantStreamAccumulator, createToolResultMessage, createUserMessage, ReasoningEffortId, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountBranchHost } from './branch-host.ts'
import type { Config } from '../src/index.ts'
import type { LoomNodeId, LoomWeaveRequest } from '../src/types.ts'

const roots: Context[] = []
const stores: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(stores.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

function response(text: string): StreamChunk[] {
  return textResponse(text).map(chunk => chunk.type === 'block-end' ? {
    ...chunk,
    logprobs: { tokens: [text], logprobs: [Math.log(0.6)], top: [[{ token: text, logprob: Math.log(0.6) }, { token: 'B', logprob: Math.log(0.4) }]] },
  } : chunk)
}

class ProseAdapter extends MockAdapter {
  readonly dispatched = Promise.withResolvers<undefined>()
  maxTopLogprobs = 20
  supportsReasoning = false
  supportsPrefix = true
  supportsProbabilities = true
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model,
      ...this.supportsProbabilities ? { tokenLogprobs: { maxTopLogprobs: this.maxTopLogprobs } } : {},
      ...this.supportsPrefix ? { assistantPrefill: 'tool-free' as const } : {},
      ...this.supportsReasoning ? { reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }] } } : {},
    })
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.dispatched.resolve(undefined)
    yield* super.stream(options)
  }
}

async function harness(script: ConstructorParameters<typeof MockAdapter>[0] = [response('A'), response('B')], config: Config = {}, persistenceRoot?: string) {
  const ctx = new Context()
  roots.push(ctx)
  const host = await mountBranchHost(ctx, { provider: 'mock', model: 'mock' }, { weave: { leadDelayMs: 0 }, ...config }, persistenceRoot)
  const adapter = new ProseAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await host.agents.create(SessionId('prose-test'), { provider: 'mock', model: 'mock' }, { cwd: tmpdir() })
  const request: LoomWeaveRequest = { sessionId: agent.id, parent: null, prefix: [{ text: 'Once ', author: 'user' }], n: 2 }
  return { ctx, host, agent, adapter, request }
}

const signal = (): AbortSignal => new AbortController().signal

describe('prose generation', () => {
  it.each(['prefix', 'probabilities'] as const)('refuses unsupported %s before recording or dispatching', async (capability) => {
    const { ctx, agent, adapter, request } = await harness()
    if (capability === 'prefix') adapter.supportsPrefix = false
    else adapter.supportsProbabilities = false
    await expect(ctx.loom.weave(request, signal())).rejects.toMatchObject({ code: 'loom/prose-unavailable',
      details: { reasonCode: capability === 'prefix' ? 'unsupported-prefix' : 'unsupported-logprobs' },
    })
    expect(agent.session.snapshotEvents()).toEqual([])
    expect(adapter.requests).toEqual([])
  })

  it('classifies cancellation during prefix resolution for localized recovery', async () => {
    const { ctx, request } = await harness()
    const abort = new AbortController()
    const inspect = ctx.sessionController.inspect.bind(ctx.sessionController)
    vi.spyOn(ctx.sessionController, 'inspect').mockImplementationOnce(async (...args) => {
      const value = await inspect(...args)
      abort.abort(new Error('Cursor request cancelled'))
      return value
    })
    await expect(ctx.loom.weave(request, abort.signal)).rejects.toMatchObject({
      code: 'loom/prose-unavailable', details: { reasonCode: 'cancelled' },
    })
  })

  it('logs exact requests before dispatch, retains siblings and does not add Chat messages', async () => {
    const { ctx, agent, adapter, request } = await harness([
      (options) => {
        const last = pluginRecordOf(agent.session.snapshotEvents().at(-1)!)
        expect(last?.type).toBe('plugin:loom/weave-request')
        expect(options.assistantPrefix).toBe('Once ')
        expect(options.tools).toBeUndefined()
        return response('A')
      }, response('B'),
    ])
    const value = await ctx.loom.weave(request, signal())
    expect(value.schedule).toBe('lead-then-burst')
    expect(value.nodes.map(node => [node.index, node.text, node.status])).toEqual([[0, 'A', 'completed'], [1, 'B', 'completed']])
    expect(value.nodes.every(node => node.prefix[0]?.text === 'Once ')).toBe(true)
    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.deriveMessages()).toEqual([])
    expect(await ctx.loom.weaveState({ sessionId: agent.id }, signal()))
      .toMatchObject({ nodes: value.nodes, curationBits: 0, modelTokens: 0 })
  })

  it('keeps list choices idempotent and replaces a choice within the same set', async () => {
    const { ctx, agent, request } = await harness()
    const value = await ctx.loom.weave(request, signal())
    const first = value.nodes[0]!, second = value.nodes[1]!
    const choose = (nodeId: LoomNodeId) => ctx.loom.choose({ sessionId: agent.id, nodeId }, signal())
    expect(await choose(first.id)).toEqual({ curationBits: 1, modelTokens: 1 })
    const before = agent.session.seq
    expect(await choose(first.id)).toEqual({ curationBits: 1, modelTokens: 1 })
    expect(agent.session.seq).toBe(before)
    expect(await choose(second.id)).toEqual({ curationBits: 1, modelTokens: 1 })
    const state = await ctx.loom.weaveState({ sessionId: agent.id }, signal())
    expect(state.choices.map(choice => choice.nodeId)).toEqual([second.id])
  })

  it('uses a warm prefix for a burst and retains edits and selected alternative attribution', async () => {
    const { ctx, request } = await harness([response('A'), response('B'), response('C'), response('D')])
    const initial = await ctx.loom.weave(request, signal())
    expect((await ctx.loom.weave(request, signal())).schedule).toBe('burst')
    const parent = initial.nodes[0]!
    const next = await ctx.loom.weave({
      ...request, parent: parent.id, n: 1,
      prefix: [{ text: 'Edited ', author: 'user' }, { text: 'A', author: 'model', node: parent.id },
        { text: 'B', author: 'alternative', node: parent.id, tokenIndex: 0 }],
    }, signal())
    expect(next.nodes[0]?.parent).toBe(parent.id)
    expect(next.nodes[0]?.prefix.map(span => span.text).join('')).toBe('Edited AB')
  })

  it('retains a failed sibling while keeping its successful sibling selectable', async () => {
    const { ctx, agent, request } = await harness([response('A'), () => { throw new Error('provider rejected') }])
    const value = await ctx.loom.weave(request, signal())
    expect(value.nodes.map(node => node.status)).toEqual(['completed', 'failed'])
    expect(value.nodes[1]?.error).toContain('provider rejected')
    expect(await ctx.loom.choose({ sessionId: agent.id, nodeId: value.nodes[0]!.id }, signal()))
      .toEqual({ curationBits: 0, modelTokens: 1 })
    await expect(ctx.loom.choose({ sessionId: agent.id, nodeId: value.nodes[1]!.id }, signal()))
      .rejects.toMatchObject({ code: 'loom/node-not-found' })
  })

  it.each([
    { n: 0 }, { n: 5 }, { n: 1.5 }, { controls: { maxTokens: 0 } }, { controls: { maxTokens: 201 } },
    { controls: { temperature: -1 } }, { controls: { temperature: 3 } }, { controls: { topLogprobs: -1 } },
    { controls: { topLogprobs: 21 } }, { controls: { stop: [''] } },
  ])('refuses invalid controls before writing a request: %j', async (override) => {
    const { ctx, agent, request } = await harness()
    await expect(ctx.loom.weave({ ...request, ...override }, signal())).rejects.toMatchObject({ code: 'loom/prose-unavailable' })
    expect(agent.session.seq).toBe(0)
  })

  it('refuses oversized prefixes, missing parents and false authored spans', async () => {
    const { ctx, agent, request } = await harness([], { weave: { maxPrefixCodePoints: 2, leadDelayMs: 0 } })
    await expect(ctx.loom.weave(request, signal())).rejects.toMatchObject({ code: 'loom/prose-unavailable' })
    const short = { ...request, prefix: [], n: 1 }
    const missing = brandString<LoomNodeId>('missing')
    await expect(ctx.loom.weave({ ...short, parent: missing }, signal())).rejects.toMatchObject({ code: 'loom/node-not-found' })
    await expect(ctx.loom.weave({ ...short, prefix: [{ text: 'A', author: 'model', node: missing }] }, signal()))
      .rejects.toMatchObject({ code: 'loom/prose-unavailable' })
    await expect(ctx.loom.weave({ ...short, prefix: [{ text: 'A', author: 'user', node: missing }] }, signal()))
      .rejects.toMatchObject({ code: 'loom/prose-unavailable' })
    expect(agent.session.seq).toBe(0)
  })

  it('bounds breadth-first probes and retains the exact alternative prefixes', async () => {
    const { ctx, agent, request } = await harness([response('A'), response('A')], { weave: { leadDelayMs: 0 }, probe: { maxRequests: 2 } })
    const value = await ctx.loom.probe({ sessionId: agent.id, parent: null, prefix: request.prefix, depth: 3 }, signal())
    expect(value.requests).toBe(2)
    expect(value.truncated).toBe(true)
    expect(value.nodes.map(node => [node.depth, node.token])).toEqual([[1, 'A'], [1, 'B'], [2, 'A'], [2, 'B']])
    expect(value.positions).toHaveLength(value.requests)
    const state = await ctx.loom.weaveState({ sessionId: agent.id }, signal())
    expect(value.positions?.every(position => state.nodes.some(node => node.id === position.sourceNodeId))).toBe(true)
    expect(value.positions?.map(position => position.parent)).toEqual([null, value.nodes[0]!.id])
    expect((await ctx.loom.weaveState({ sessionId: agent.id }, signal())).nodes.every(node => node.kind === 'probe')).toBe(true)
    await expect(ctx.loom.probe({ sessionId: agent.id, parent: null, prefix: [], depth: 5 }, signal()))
      .rejects.toMatchObject({ code: 'loom/prose-unavailable' })
  })

  it('reports a model that returns no probabilities instead of inventing alternatives', async () => {
    const { ctx, agent } = await harness([textResponse('A')])
    await expect(ctx.loom.probe({ sessionId: agent.id, parent: null, prefix: [], depth: 1 }, signal()))
      .rejects.toMatchObject({ code: 'loom/prose-unavailable' })
  })

  it('cancels active and unstarted siblings on unload and retains all settlements', async () => {
    const { ctx, host, agent, adapter, request } = await harness(['hang'])
    const weaving = ctx.loom.weave(request, signal())
    await adapter.dispatched.promise
    await host.loom.dispose()
    const value = await weaving
    expect(value.nodes.map(node => node.status)).toEqual(['cancelled', 'cancelled'])
    expect(agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(1)
  })

  it('records a child content replacement and continues without editing its source', async () => {
    const { ctx, host, agent, adapter } = await harness([toolCallResponse('lookup', 'lookup', {}), textResponse('original answer'), textResponse('counterfactual answer')])
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({ name: 'lookup', description: 'Look up a value.', parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'original result' }]),
    })))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Look it up.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const before = agent.session.snapshotEvents()
    const result = before.find(event => event.type === 'tool/result')
    if (result?.type !== 'tool/result') throw new Error('Missing original tool result')
    const forked = await ctx.loom.counterfactual({ sessionId: agent.id, resultSeq: result.seq,
      content: [{ type: 'text', text: 'edited result' }],
    }, signal())
    const child = ctx.agents.get(forked.sessionId)
    if (child === undefined) throw new Error('Missing child')
    await child.whenIdle()
    expect(child.session.deriveMessages().some(message => message.role === 'tool' && message.content.some(block => block.type === 'text' && block.text === 'edited result'))).toBe(true)
    expect(child.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(agent.session.snapshotEvents()).toEqual(before)
    expect(adapter.requests).toHaveLength(3)
    expect(host.archives.calls).toEqual([])
    await expect(ctx.loom.counterfactual({ sessionId: agent.id, resultSeq: SessionSeq(0), content: [] }, signal()))
      .rejects.toMatchObject({ code: 'loom/counterfactual-unavailable' })
    const override = child.session.snapshotEvents().map(pluginRecordOf).find(record => record?.type === 'plugin:loom/tool-result-override')
    expect(override?.data).toMatchObject({ resultSeq: result.seq, replacementSeq: forked.replacementSeq })
  })

  it('preserves every companion result when editing one tool of a multi-tool step', async () => {
    const multiple = [...toolCallResponse('first', 'lookup', { value: 'one' }).slice(0, -2),
      ...toolCallResponse('second', 'lookup', { value: 'two' }).map(chunk => 'index' in chunk ? { ...chunk, index: 1 } : chunk)]
    const { ctx, agent, adapter } = await harness([multiple, textResponse('original'), textResponse('edited')])
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({ name: 'lookup', description: 'Return a value.',
      parameters: { value: { type: 'string' } }, execute: args => Promise.resolve([{ type: 'text', text: String(args.value) }]),
    })))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read both values.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const first = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    if (first?.type !== 'tool/result') throw new Error('Missing first result')
    const branch = await ctx.loom.counterfactual({ sessionId: agent.id, resultSeq: first.seq, content: [{ type: 'text', text: 'changed' }] }, signal())
    await ctx.agents.get(branch.sessionId)?.whenIdle()
    expect(adapter.requests[2]?.messages.filter(message => message.role === 'tool').map(message => message.content))
      .toEqual([[{ type: 'text', text: 'changed' }], [{ type: 'text', text: 'two' }]])
    const repeated = await ctx.loom.counterfactual({ sessionId: branch.sessionId, resultSeq: branch.replacementSeq,
      content: [{ type: 'text', text: 'changed again' }],
    }, signal())
    await ctx.agents.get(repeated.sessionId)?.whenIdle()
    expect(repeated.sessionId).not.toBe(branch.sessionId)
  })

  it('persists and reloads the replacement inside its continuation turn', async () => {
    const store = await mkdtemp(join(tmpdir(), 'dsh-loom-counterfactual-'))
    stores.push(store)
    const { ctx, agent } = await harness([
      toolCallResponse('lookup', 'lookup', {}), textResponse('original'), textResponse('changed'),
    ], {}, store)
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({ name: 'lookup', description: 'Return a value.', parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'original' }]),
    })))
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the value.' }] }))
    await agent.whenIdle()
    const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    if (result === undefined) throw new Error('Missing original result')
    const branch = await ctx.loom.counterfactual({ sessionId: agent.id, resultSeq: result.seq, content: [{ type: 'text', text: 'changed' }] }, signal())
    const child = ctx.agents.get(branch.sessionId)!
    await child.whenIdle()
    await ctx.sessions.flush(child.session)
    const expected = child.session.snapshotEvents()
    const handle = await ctx.sessionPersistence.open(child.id, 'read')
    try {
      expect((await handle.read()).events).toEqual(expected)
    } finally {
      await handle.close()
    }
    const own = expected.slice(child.session.inheritedEventCount)
    const start = own.findIndex(event => event.type === 'turn/start' && event.data.continuation !== undefined)
    const replacement = own.findIndex(event => event.seq === branch.replacementSeq)
    const step = own.findIndex(event => event.type === 'step/start')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(replacement).toBeGreaterThan(start)
    expect(step).toBeGreaterThan(replacement)
    await ctx.fiber.dispose()
    const reloaded = new Context()
    roots.push(reloaded)
    await mountBranchHost(reloaded, { provider: 'mock', model: 'mock' }, {}, store)
    expect((await reloaded.sessionController.inspect(child.id)).events).toEqual(expected)
  })

  it.each(['write', 'policy', 'idle'] as const)('reports a retained child when %s prevents the first replacement', async (failure) => {
    const { ctx, agent } = await harness([
      toolCallResponse('lookup', 'lookup', {}), textResponse('original'), textResponse('child'),
    ])
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({ name: 'lookup', description: 'Return a value.', parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'original' }]),
    })))
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read a value.' }] }))
    await agent.whenIdle()
    const result = agent.session.snapshotEvents().find(event => event.type === 'tool/result')!
    const resolve = ctx.sessionController.resolveAgent.bind(ctx.sessionController)
    vi.spyOn(ctx.sessionController, 'resolveAgent').mockImplementationOnce(async (id) => {
      const resolved = await resolve(id)
      if ('agent' in resolved) {
        if (failure === 'policy') resolved.agent.ctx.on('agent/pre-step', () => Promise.resolve({ kind: 'reject' }))
        if (failure === 'idle') vi.spyOn(resolved.agent, 'whenIdle').mockRejectedValueOnce(new Error('The driver could not report quiescence'))
      }
      return resolved
    })
    if (failure === 'write') {
      const flush = ctx.sessions.flush.bind(ctx.sessions)
      vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
        if (session.id !== agent.id && session.snapshotEvents().at(-1)?.type === 'tool/result') throw new Error('Replacement write failed')
        return flush(session)
      })
    }
    const pending = ctx.loom.counterfactual({ sessionId: agent.id, resultSeq: result.seq, content: [] }, signal())
    await expect(pending).rejects.toMatchObject({ code: 'loom/counterfactual-incomplete' })
    await expect(pending).rejects.toHaveProperty('details.childSessionId', expect.any(String))
  })

  it('refuses unfinished tool batches and reports child persistence failures explicitly', async () => {
    const { ctx, agent } = await harness()
    const unfinished = agent.session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: ToolCallId('pending-companion'), content: [{ type: 'text', text: 'first value' }], isError: false }),
    }, { surfaceOp: 'append' })
    await expect(ctx.loom.counterfactual({ sessionId: agent.id, resultSeq: unfinished.seq, content: [] }, signal()))
      .rejects.toMatchObject({ code: 'loom/counterfactual-unavailable' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(session => session.id === agent.id ? flush(session) : Promise.reject(new Error('disk unavailable')))
    await expect(ctx.loom.counterfactual({ sessionId: agent.id, resultSeq: unfinished.seq, content: [] }, signal()))
      .rejects.toMatchObject({ code: 'loom/counterfactual-incomplete', details: { sessionId: agent.id } })
  })

  it('reports unavailable Sessions and a busy maintenance owner without starting a request', async () => {
    const { ctx, agent, adapter, request } = await harness()
    await expect(ctx.loom.weave({ ...request, sessionId: SessionId('missing') }, signal())).rejects.toMatchObject({ code: 'session/not-found' })
    const barrier = Promise.withResolvers<undefined>()
    const maintenance = agent.runMaintenance(() => barrier.promise)
    await expect(ctx.loom.weave(request, signal())).rejects.toMatchObject({ code: 'loom/prose-unavailable' })
    barrier.resolve(undefined)
    await maintenance
    expect(adapter.requests).toEqual([])
  })

  it('turns thinking off explicitly, resolves route picks and honors stop controls', async () => {
    const { ctx, agent, adapter, request } = await harness([response('A'), response('B')], { weave: { leadDelayMs: 0, warmWindowMs: 0 } })
    adapter.supportsReasoning = true
    agent.session.append('model/selection', { provider: 'mock', model: 'alternate' })
    const first = await ctx.loom.weave({ ...request, n: 1, controls: { stop: ['END'] } }, signal())
    expect(first.nodes).toMatchObject([{ status: 'completed' }])
    expect(first.nodes[0]?.error).toBeUndefined()
    expect(adapter.requests[0]).toMatchObject({ model: 'alternate', reasoningEffort: 'off', stop: ['END'] })
    const next = await ctx.loom.weave({ ...request, n: 1, route: { provider: 'mock', model: 'mock' } }, signal())
    expect(adapter.requests[1]?.model).toBe('mock')
    expect(next.nodes[0]?.status).toBe('completed')
  })

  it('bounds cutoff controls and completes a shallow probe without inventing low-probability nodes', async () => {
    const { ctx, agent, request } = await harness([response('A')])
    const value = await ctx.loom.probe({ sessionId: agent.id, parent: null, prefix: [], depth: 1, cutoff: 0.5,
      route: { provider: 'mock', model: 'mock' },
    }, signal())
    expect(value.nodes.map(node => node.token)).toEqual(['A'])
    expect(value.truncated).toBe(false)
    await expect(ctx.loom.probe({ sessionId: agent.id, parent: null, prefix: request.prefix, cutoff: 0 }, signal()))
      .rejects.toMatchObject({ code: 'loom/prose-unavailable' })
  })

  it('cancels the configured lead timer and does not dispatch unstarted siblings', async () => {
    const { ctx, adapter, request } = await harness(['hang'], { weave: { leadDelayMs: 1500 } })
    vi.useFakeTimers()
    const abort = new AbortController()
    const weaving = ctx.loom.weave(request, abort.signal)
    await adapter.dispatched.promise
    await vi.advanceTimersByTimeAsync(0)
    abort.abort(new Error('user stopped prose'))
    const value = await weaving
    expect(value.nodes.map(node => node.status)).toEqual(['cancelled', 'cancelled'])
    expect(adapter.requests).toHaveLength(1)
  })

  it('retains a completed lead when a non-Error abort cancels the configured burst delay', async () => {
    const { ctx, adapter, request } = await harness([response('A'), response('B')], { weave: { leadDelayMs: 1500 } })
    vi.useFakeTimers()
    const abort = new AbortController()
    const weaving = ctx.loom.weave(request, abort.signal)
    await adapter.dispatched.promise
    await vi.advanceTimersByTimeAsync(0)
    abort.abort('user stopped prose')
    const value = await weaving
    expect(value.nodes.map(node => node.status)).toEqual(['completed', 'cancelled'])
    expect(adapter.requests).toHaveLength(1)
  })

  it('preserves preparation failures for a sibling when its provider capability changes', async () => {
    const { ctx, adapter, request } = await harness([() => { adapter.maxTopLogprobs = 0; return response('A') }])
    const value = await ctx.loom.weave(request, signal())
    expect(value.nodes.map(node => node.status)).toEqual(['completed', 'failed'])
    expect(value.nodes[1]?.error).toContain('topLogprobs')
    await expect(ctx.loom.weave({ ...request, n: 1 }, signal())).rejects.toMatchObject({ code: 'loom/prose-unavailable', details: { reasonCode: 'unsupported-logprobs' } })
  })

  it('stops sibling dispatch when a settlement cannot be recorded', async () => {
    const { ctx, adapter, request } = await harness()
    vi.spyOn(AssistantStreamAccumulator.prototype, 'snapshot').mockImplementationOnce(() => {
      throw new Error('The stream settlement could not be encoded')
    })
    await expect(ctx.loom.weave(request, signal())).rejects.toMatchObject({ code: 'loom/prose-unavailable' })
    expect(adapter.requests).toHaveLength(1)
  })

  it('retains failure settlements for empty or malformed streams and preserves an already terminal response', async () => {
    const invalid: StreamChunk = { type: 'text-delta', index: -1, text: 'invalid' }
    const { ctx, request } = await harness([[], [invalid], [...response('A'), invalid]])
    const empty = await ctx.loom.weave({ ...request, n: 1 }, signal())
    expect(empty.nodes[0]?.status).toBe('failed')
    expect(empty.nodes[0]?.error).toContain('without a finish')
    const malformed = await ctx.loom.weave({ ...request, n: 1 }, signal())
    expect(malformed.nodes[0]?.status).toBe('failed')
    const terminal = await ctx.loom.weave({ ...request, n: 1 }, signal())
    expect(terminal.nodes[0]).toMatchObject({ text: 'A', status: 'completed' })
  })

  it('requires a selected route for an Agent created without model options', async () => {
    const { ctx, host, request } = await harness()
    const empty = await host.agents.create(SessionId('no-route'))
    await expect(ctx.loom.weave({ ...request, sessionId: empty.id, n: 1 }, signal()))
      .rejects.toMatchObject({ code: 'loom/prose-unavailable' })
  })

  it('preserves a failure activating the newly created counterfactual child', async () => {
    const { ctx, agent } = await harness()
    const result = agent.session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: ToolCallId('tool'), content: [{ type: 'text', text: 'value' }], isError: false }),
    }, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    vi.spyOn(ctx.sessionController, 'resolveAgent').mockResolvedValueOnce({
      error: new RemoteError('session/writer-held', 'The child writer is held.', { sessionId: SessionId('held-child') }),
    })
    const pending = ctx.loom.counterfactual({ sessionId: agent.id, resultSeq: result.seq, content: [] }, signal())
    await expect(pending).rejects.toMatchObject({ code: 'loom/counterfactual-incomplete', details: { sessionId: agent.id } })
    await expect(pending).rejects.toHaveProperty('details.childSessionId', expect.any(String))
    await expect(pending).rejects.toHaveProperty('details.reason', expect.stringContaining('The child writer is held'))
  })
})
