/** `loom.requestAt` rebuilds the request the model received at a seq, equal to the request the agent loop sent. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, type AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  createDeveloperMessage,
  createSystemMessage,
  createUserMessage,
  isAgentLoopRequest,
  LlmError,
  ReasoningEffortId,
  type ContextFormed,
  type GenerateOptions,
  type Message,
} from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createSessionTestRemote, type TestSessionRemote } from '../../../api/session-controller/tests/test-remote.ts'
import Loom, { LOOM_REQUEST_PREVIEW_MAX_CODE_POINTS } from '../src/index.ts'
import { messageText, previewOf, rebuildRequest } from '../src/request-at.ts'
import type { LoomRequestView } from '../src/types.ts'
import { requestRows } from './request-rows.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Test-only compaction summary that replaces a surface range. */
    'loom-test-compact': { kind: 'loom-test-compact' } & ContextFormed
  }
}

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => root.fiber.dispose())) })

const signal = new AbortController().signal
const prompt = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

interface Harness {
  readonly ctx: Context
  readonly agents: AgentLoopTestHarness
  readonly adapter: MockAdapter
  readonly remote: TestSessionRemote
  /** Requests the agent loop sent, as `llm/stream` listeners receive them before route projection. */
  readonly requests: GenerateOptions[]
}

type AdapterArgs = ConstructorParameters<typeof MockAdapter>

async function harness(script: AdapterArgs[0], reasoning?: AdapterArgs[1]): Promise<Harness> {
  const ctx = new Context()
  roots.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'You are the Loom test agent.' } })
  const agents = await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter(script, reasoning)
  ctx.llm.registerAdapter(['mock'], adapter)
  const requests: GenerateOptions[] = []
  ctx.on('llm/stream', (options, next) => {
    if (isAgentLoopRequest(options)) requests.push(options)
    return next()
  })
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  // Loom reads the filesystem only to isolate children in worktrees, which these specs never request.
  ctx.provide('fs', {} as never)
  const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }), cwd: '/tmp' })
  await ctx.plugin(Loom)
  return { ctx, agents, adapter, remote, requests }
}

async function run(agent: Agent, text: string): Promise<void> {
  agent.followup(prompt(text))
  await agent.whenIdle()
}

async function fork(h: Harness, source: Agent): Promise<Agent> {
  const response = await h.remote.fork({ sessionId: source.id })
  if (!response.ok) throw response.error
  const child = h.ctx.agents.get(response.value.sessionId)
  if (child === undefined) throw new Error('fork child is not live')
  return child
}

async function eventsOf(h: Harness, agent: Agent): Promise<readonly SessionEvent[]> {
  return (await h.ctx.sessionController.inspect(agent.id)).events
}

function settlements(events: readonly SessionEvent[]) {
  return events.filter(event => event.type === 'assistant/message' || event.type === 'assistant/attempt')
}

function requestAt(h: Harness, agent: Agent, seq: number): Promise<LoomRequestView> {
  return h.ctx.loom.requestAt({ sessionId: agent.id, seq: seq as SessionSeq }, signal)
}

/** The view fields a logged request determines on its own. */
function fromRequest(request: GenerateOptions) {
  return {
    route: {
      provider: request.provider,
      model: request.model,
      ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort },
    },
    toolNames: (request.tools ?? []).map(tool => tool.name),
    messages: requestRows(request.messages),
  }
}

/** Every request the agent sent itself, against the views rebuilt at its settlements. */
async function expectOwnRequests(h: Harness, agent: Agent): Promise<LoomRequestView[]> {
  const events = await eventsOf(h, agent)
  const { inheritedEventCount } = agent.session
  const own = settlements(events).filter(event => event.seq >= inheritedEventCount)
  const requests = h.requests.filter(request => request.sessionId === agent.id)
  expect(own).toHaveLength(requests.length)
  const views: LoomRequestView[] = []
  for (const [index, settlement] of own.entries()) {
    const request = requests[index]!
    expect(rebuildRequest(events, settlement, h.ctx.sessions.messageProjections).nodes.map(node => node.message))
      .toEqual(structuredClone(request.messages))
    const view = await requestAt(h, agent, settlement.seq)
    const logged = fromRequest(request)
    expect(view.route).toEqual(logged.route)
    expect(view.tools.names).toEqual(logged.toolNames)
    expect(view.messages.map(({ role, preview, chars }) => ({ role, preview, chars }))).toEqual(logged.messages)
    expect(view.messages.map(message => message.inherited)).toEqual(view.messages.map(message => message.seq < inheritedEventCount))
    views.push(view)
  }
  return views
}

describe('loom.requestAt', () => {
  it('rebuilds every request across a fork of a fork and splits each at its cut', async () => {
    const h = await harness([
      toolCallResponse('c1', 'echo', { text: 'one' }, 'calling'),
      textResponse('root done'),
      textResponse('child done'),
      textResponse('grandchild done'),
    ])
    h.ctx.tools.register(defineContentToolFixture({
      name: 'echo', description: 'echo back', parameters: { text: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: `echo: ${String(args.text)}` }] },
    }))
    const root = await h.agents.create(SessionId('root'), { provider: 'mock', model: 'mock' })
    await run(root, 'first')
    const child = await fork(h, root)
    await run(child, 'second')
    const grandchild = await fork(h, child)
    await run(grandchild, 'third')

    const [rootFirst, rootSecond] = await expectOwnRequests(h, root)
    expect(rootFirst!.messages.map(message => message.role)).toEqual(['system', 'user'])
    expect(rootSecond!.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool'])
    expect(rootSecond!.messages[2]).toMatchObject({ preview: 'calling echo {"text":"one"}', chars: 27 })
    expect(rootSecond!.messages[3]).toMatchObject({ role: 'tool', preview: 'echo: one', chars: 9, inherited: false })
    expect(rootSecond).toMatchObject({ inheritedTurns: 0, ownTurns: 1 })
    expect(rootSecond!.systemPrompt.text).toContain('You are the Loom test agent.')
    expect(rootSecond!.systemPrompt.chars).toBe(Array.from(rootSecond!.systemPrompt.text).length)
    expect(rootSecond!.systemPrompt).not.toHaveProperty('changedAtTurn')
    expect(rootSecond!.tools).toEqual({ names: ['echo'], addedThisTurn: [], removedThisTurn: [] })

    const [childView] = await expectOwnRequests(h, child)
    expect(childView).toMatchObject({ inheritedTurns: 1, ownTurns: 1 })
    expect(childView!.messages.map(message => [message.role, message.inherited])).toEqual([
      ['system', true], ['user', true], ['assistant', true], ['tool', true], ['assistant', true], ['user', false],
    ])

    const [grandchildView] = await expectOwnRequests(h, grandchild)
    expect(grandchildView).toMatchObject({ inheritedTurns: 2, ownTurns: 1 })
    expect(grandchildView!.messages.filter(message => !message.inherited).map(message => message.preview)).toEqual(['third'])
    expect(grandchildView!.messages.at(-2)).toMatchObject({ role: 'assistant', preview: 'child done', inherited: true })

    // An inherited settlement addresses the request its source sent, read from the descendant's own log.
    const grandchildEvents = await eventsOf(h, grandchild)
    const inheritedFirst = settlements(grandchildEvents)[0]!
    const inheritedView = await requestAt(h, grandchild, inheritedFirst.seq)
    expect(inheritedView.messages.map(({ role, preview, chars }) => ({ role, preview, chars })))
      .toEqual(fromRequest(h.requests[0]!).messages)
    expect(inheritedView.messages.every(message => message.inherited)).toBe(true)
    expect(inheritedView).toMatchObject({ inheritedTurns: 1, ownTurns: 0 })

    // Any later event addresses the latest request settled at or before it.
    expect(await requestAt(h, grandchild, grandchildEvents.length - 1)).toEqual(grandchildView)
  })

  it('rebuilds the request after a compaction replacement of inherited history', async () => {
    const h = await harness([textResponse('root done'), textResponse('child done')])
    const root = await h.agents.create(SessionId('compact-root'), { provider: 'mock', model: 'mock' })
    await run(root, 'older history '.repeat(40))
    const child = await fork(h, root)
    const nodes = child.session.surface.nodes
    child.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '[summary of turn 1]' }],
      source: { kind: 'loom-test-compact' },
    }), { surfaceOp: { op: 'replace', startSeq: nodes[1]!, endSeq: nodes[2]! }, sourceEventSeqs: [nodes[1]!, nodes[2]!] })
    await run(child, 'after compaction')

    const [view] = await expectOwnRequests(h, child)
    expect(view!.messages.map(message => [message.role, message.preview, message.inherited])).toEqual([
      ['system', view!.messages[0]!.preview, true],
      ['user', '[summary of turn 1]', false],
      ['user', 'after compaction', false],
    ])
    expect(view).toMatchObject({ inheritedTurns: 1, ownTurns: 1 })
  })

  it('rebuilds each attempt of a step that retried', async () => {
    const h = await harness([
      () => { throw new LlmError('provider busy', 'RATE_LIMITED') },
      textResponse('recovered'),
    ])
    let retried = false
    h.ctx.on('agent/request-error', () => {
      if (retried) return Promise.resolve(undefined)
      retried = true
      return Promise.resolve({ kind: 'retry' as const })
    })
    const agent = await h.agents.create(SessionId('retry'), { provider: 'mock', model: 'mock' })
    await run(agent, 'go')

    const events = await eventsOf(h, agent)
    expect(settlements(events).map(event => event.type)).toEqual(['assistant/attempt', 'assistant/message'])
    const [attempt, message] = await expectOwnRequests(h, agent)
    expect(attempt).toEqual(message)
    expect(h.requests).toHaveLength(2)
    expect(h.adapter.requests).toHaveLength(2)
  })

  it('reports the route, the tool changes, and the rebuilt system prompt of the request turn', async () => {
    const reasoning = { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('high') }
    const h = await harness([textResponse('one'), textResponse('two'), textResponse('three')], reasoning)
    const disposeEcho = h.ctx.tools.register(defineContentToolFixture({
      name: 'echo', description: 'echo back', parameters: {},
      async execute() { return [{ type: 'text', text: 'echo' }] },
    }))
    const agent = await h.agents.create(SessionId('changes'), { provider: 'mock', model: 'mock', reasoningEffort: ReasoningEffortId('high') })
    await run(agent, 'first')
    disposeEcho()
    h.ctx.tools.register(defineContentToolFixture({
      name: 'late', description: 'arrives in turn 2', parameters: {},
      async execute() { return [{ type: 'text', text: 'late' }] },
    }))
    h.ctx.systemPrompt.section({ name: 'extra', order: 2, text: 'new guidance for turn 2' })
    await run(agent, 'second')
    await run(agent, 'third')

    const [first, second, third] = await expectOwnRequests(h, agent)
    expect(first!.route).toEqual({ provider: 'mock', model: 'mock', reasoningEffort: 'high' })
    expect(first!.tools).toEqual({ names: ['echo'], addedThisTurn: [], removedThisTurn: [] })
    expect(first!.systemPrompt).not.toHaveProperty('changedAtTurn')
    expect(second!.tools).toEqual({ names: ['late'], addedThisTurn: ['late'], removedThisTurn: ['echo'] })
    expect(second!.messages.filter(message => message.preview === '+late -echo')).toHaveLength(1)
    expect(second!.systemPrompt).toMatchObject({ changedAtTurn: 2, text: expect.stringContaining('new guidance for turn 2') as string })
    expect(third!.tools).toEqual({ names: ['late'], addedThisTurn: [], removedThisTurn: [] })
    expect(third!.systemPrompt).toEqual(second!.systemPrompt)
  })

  it('reports seqs outside the request range and unknown Sessions as typed failures', async () => {
    const h = await harness([textResponse('done')])
    const agent = await h.agents.create(SessionId('range'), { provider: 'mock', model: 'mock' })
    await run(agent, 'go')
    const events = await eventsOf(h, agent)
    const range = { from: settlements(events)[0]!.seq, to: events.length - 1 }
    for (const seq of [-1, 1.5, events.length, 0]) {
      await expect(requestAt(h, agent, seq)).rejects.toMatchObject({
        code: 'loom/seq-out-of-range', details: { sessionId: 'range', seq, range },
      })
    }

    const quiet = h.ctx.sessions.create(SessionId('no-request'), { meta: { cwd: '/tmp' } })
    quiet.append('turn/start', { turn: 1 })
    quiet.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(h.ctx.loom.requestAt({ sessionId: quiet.id, seq: SessionSeq(1) }, signal)).rejects.toMatchObject({
      code: 'loom/seq-out-of-range', details: { range: null },
    })

    await expect(h.ctx.loom.requestAt({ sessionId: SessionId('missing'), seq: SessionSeq(0) }, signal))
      .rejects.toMatchObject({ code: 'session/not-found', details: { sessionId: 'missing' } })
    const failure = new Error('persistence offline')
    vi.spyOn(h.ctx.sessionController, 'inspect').mockRejectedValueOnce(failure)
    await expect(requestAt(h, agent, 0)).rejects.toBe(failure)
  })
})

describe('request views of hand-written logs', () => {
  it('skips empty nodes, reports developer text, and refuses a settlement without a request header', async () => {
    const h = await harness([])
    const session = h.ctx.sessions.create(SessionId('hand'), { meta: { cwd: '/tmp' } })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('') }, { surfaceOp: 'append' })
    session.append('user/message', prompt('plain'), { surfaceOp: 'append' })
    const unheaded = session.append('assistant/attempt', { turn: 1, step: 1, stream: [] })
    await expect(h.ctx.loom.requestAt({ sessionId: session.id, seq: unheaded.seq }, signal)).rejects.toMatchObject({
      code: 'gateway/internal',
      message: `Session "hand" logs no request/header before the request settled at seq ${String(unheaded.seq)}`,
    })

    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('request/header', { header: { config: { provider: 'hand', model: 'written' } }, reason: 'initial' })
    const note = session.append('developer/message', {
      turn: 2, step: 1, message: createDeveloperMessage({ content: [{ type: 'text', text: 'note' }], source: { kind: 'user' } }),
    }, { surfaceOp: 'append' })
    const settled = session.append('assistant/attempt', { turn: 2, step: 1, stream: [] })
    expect(await h.ctx.loom.requestAt({ sessionId: session.id, seq: settled.seq }, signal)).toEqual({
      route: { provider: 'hand', model: 'written' },
      systemPrompt: { chars: 0, text: '' },
      tools: { names: [], addedThisTurn: [], removedThisTurn: [] },
      messages: [
        { seq: 3, role: 'user', inherited: false, preview: 'plain', chars: 5 },
        { seq: note.seq, role: 'system', inherited: false, preview: 'note', chars: 4 },
      ],
      inheritedTurns: 0,
      ownTurns: 2,
    })
  })
})

describe('message text', () => {
  it('renders every block kind and bounds the collapsed preview', () => {
    const image = { attachmentId: 'img', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
    const message: Message = {
      ...prompt('x'),
      content: [
        { type: 'text', text: 'Hello\n\n  world' },
        { type: 'reasoning', text: 'thinking' },
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' },
        { type: 'tool-addition', toolName: 'late' },
        { type: 'tool-removal', toolName: 'gone' },
        { type: 'image', attachment: image },
        { type: 'image', attachment: { ...image, name: 'shot.png' } },
        { type: 'file', attachment: { attachmentId: 'f', name: 'notes.txt', bytes: 1 } },
        { type: 'loom-test-block' },
        { type: 'text', text: '' },
      ] as never,
    }
    expect(messageText(message)).toBe('Hello\n\n  world\nthinking\nread {"path":"a"}\n+late\n-gone\n[image/png]\n[shot.png]\n[notes.txt]')
    expect(previewOf('  a \n b  ')).toBe('a b')
    const exact = '字'.repeat(LOOM_REQUEST_PREVIEW_MAX_CODE_POINTS)
    expect(previewOf(exact)).toBe(exact)
    expect(previewOf(`${exact}😀`)).toBe(`${'字'.repeat(LOOM_REQUEST_PREVIEW_MAX_CODE_POINTS - 1)}…`)
    expect(Array.from(previewOf('😀'.repeat(500)))).toHaveLength(LOOM_REQUEST_PREVIEW_MAX_CODE_POINTS)
  })
})
