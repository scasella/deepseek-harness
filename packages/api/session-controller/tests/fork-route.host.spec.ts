/**
 * Fork child routes and the prompt-cache Session of a fork family, through the
 * production agent loop and a scripted adapter, and the family-root walk the
 * Agent controller applies when it creates, reuses, resumes, or forks a Session.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory, AgentOptions } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ApiSessionAgentController } from '../src/agent.ts'
import { completedPrefixBefore } from '../src/index.ts'
import type { SessionForkRequest } from '../src/types.ts'
import {
  createSessionTestRemote, installSessionReadTestServices, testSessionPersistence, type TestSessionRemote,
} from './test-remote.ts'

const ROUTE = 'mock-route'
const ALIAS = 'mock-alias'
const MODEL = 'mock-model'
const UNROUTED = { provider: 'unrouted-default', model: 'unrouted-default' }
const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Scripted adapter that advertises one model on every route it serves, as GUI selection requires. */
class CatalogMockAdapter extends MockAdapter {
  constructor(script: StreamChunk[][], private readonly unresolvable = new Set<string>()) {
    super(script)
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: MODEL, name: MODEL }, { provider, id: 'unresolvable', name: 'Unresolvable' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (this.unresolvable.has(model)) return Promise.reject(new Error(`model "${model}" metadata is offline`))
    return super.resolveModel(provider, model)
  }
}

interface LoopHarness {
  readonly ctx: Context
  readonly agents: AgentLoopTestHarness
  readonly adapter: CatalogMockAdapter
  readonly remote: TestSessionRemote
  readonly saved: ReturnType<typeof vi.fn>
}

async function loopHarness(replies: number): Promise<LoopHarness> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const agents = await mountAgentLoopTestHarness(ctx)
  const adapter = new CatalogMockAdapter(
    Array.from({ length: replies }, (_, index) => textResponse(`reply ${String(index + 1)}`)),
    new Set(['unresolvable']),
  )
  ctx.llm.registerAdapter([ROUTE, ALIAS], adapter)
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  const saved = vi.fn()
  // No adapter serves the default route, so a child request on it would fail.
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => UNROUTED, saveDefaultModelSelection: saved, cwd: '/tmp',
  })
  return { ctx, agents, adapter, remote, saved }
}

async function runTurn(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

async function fork(harness: LoopHarness, request: SessionForkRequest): Promise<Agent> {
  const response = await harness.remote.fork(request)
  if (!response.ok) throw response.error
  const child = harness.ctx.agents.get(response.value.sessionId)
  if (child === undefined) throw new Error('the fork did not publish its child Agent')
  return child
}

/** Events a Session wrote itself, after its inherited prefix. */
function ownEvents(agent: Agent): SessionEvent[] {
  return agent.session.snapshotEvents().slice(agent.session.inheritedEventCount)
}

function picks(events: readonly SessionEvent[]): unknown[] {
  return events.flatMap(event => event.type === 'model/selection' ? [event.data] : [])
}

function switchNotices(events: readonly SessionEvent[]): number {
  return events.filter(event => event.type === 'user/message' && event.data.source.kind === 'model-selection').length
}

function routeOf(request: GenerateOptions | undefined) {
  return { provider: request?.provider, sessionId: request?.sessionId, cacheSessionId: request?.cacheSessionId }
}

describe('fork child routes through the agent loop', () => {
  it('continues on the parent route and keys every descendant prompt cache by the family root', async () => {
    const harness = await loopHarness(4)
    const parent = await harness.agents.create(SessionId('family-root'), { provider: ROUTE, model: MODEL })
    await runTurn(parent, 'first')
    await runTurn(parent, 'second')
    const atSeq = completedPrefixBefore(parent.session.snapshotEvents(), 2)

    const child = await fork(harness, { sessionId: parent.id, ...atSeq === undefined ? {} : { atSeq } })
    await runTurn(child, 'child prompt')
    const grandchild = await fork(harness, { sessionId: child.id })
    await runTurn(grandchild, 'grandchild prompt')

    expect(atSeq).toBeDefined()
    const [, parentSecond, childFirst, grandchildFirst] = harness.adapter.requests
    expect(harness.adapter.requests.map(routeOf)).toEqual([
      { provider: ROUTE, sessionId: parent.id, cacheSessionId: undefined },
      { provider: ROUTE, sessionId: parent.id, cacheSessionId: undefined },
      { provider: ROUTE, sessionId: child.id, cacheSessionId: parent.id },
      { provider: ROUTE, sessionId: grandchild.id, cacheSessionId: parent.id },
    ])
    expect(childFirst?.messages.slice(0, -1)).toEqual(parentSecond?.messages.slice(0, -1))
    expect(grandchildFirst?.messages.slice(0, -2)).toEqual(childFirst?.messages)
    expect([...picks(ownEvents(child)), ...picks(ownEvents(grandchild))]).toEqual([])
    expect(switchNotices(child.session.snapshotEvents())).toBe(0)
  })

  it('routes an explicit selection in the child only, with a switch notice, and never saves it', async () => {
    const harness = await loopHarness(2)
    const parent = await harness.agents.create(SessionId('override-source'), { provider: ROUTE, model: MODEL })
    await runTurn(parent, 'first')
    const parentEvents = parent.session.snapshotEvents()

    const child = await fork(harness, { sessionId: parent.id, selection: { provider: ALIAS, model: MODEL } })
    await runTurn(child, 'child prompt')

    expect(routeOf(harness.adapter.requests[1])).toEqual({ provider: ALIAS, sessionId: child.id, cacheSessionId: parent.id })
    expect(picks(ownEvents(child))).toEqual([{ provider: ALIAS, model: MODEL }])
    expect(switchNotices(ownEvents(child))).toBe(1)
    expect(harness.adapter.requests[1]?.messages.at(-1)).toMatchObject({ source: { kind: 'model-selection' } })
    expect(parent.session.snapshotEvents()).toEqual(parentEvents)
    expect(harness.saved).not.toHaveBeenCalled()
    expect(harness.ctx.agentDefaultModel.currentSelection()).toEqual(UNROUTED)
  })

  it.each([
    { name: 'an unlisted model', selection: { provider: ALIAS, model: 'missing-model' }, message: 'Select an available model' },
    { name: 'an unregistered provider', selection: { provider: 'nowhere', model: MODEL }, message: 'Select an available model' },
    { name: 'a model whose metadata fails', selection: { provider: ALIAS, model: 'unresolvable' }, message: 'metadata is offline' },
  ])('rejects $name with session/model-unavailable before any child exists', async ({ selection, message }) => {
    const harness = await loopHarness(1)
    const parent = await harness.agents.create(SessionId('rejecting-source'), { provider: ROUTE, model: MODEL })
    await runTurn(parent, 'first')
    const create = vi.spyOn(harness.ctx.agents, 'create')

    const response = await harness.remote.fork({ sessionId: parent.id, selection })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'session/model-unavailable', details: { provider: selection.provider, model: selection.model } },
    })
    expect(response.ok ? '' : response.error.message).toContain(message)
    expect(create).not.toHaveBeenCalled()
    expect([...harness.ctx.agents.list()].map(agent => agent.id)).toEqual([parent.id])
    expect(harness.saved).not.toHaveBeenCalled()
  })

  it('runs a cut before the first request on the route that request ran on, without a switch notice', async () => {
    const harness = await loopHarness(2)
    const parent = await harness.agents.create(SessionId('turn-one-source'), { provider: ROUTE, model: MODEL })
    await runTurn(parent, 'first')
    const firstInput = parent.session.snapshotEvents().find(event => event.type === 'user/message')
    if (firstInput === undefined) throw new Error('the source logged no user message')

    const child = await fork(harness, { sessionId: parent.id, atSeq: firstInput.seq })
    await runTurn(child, 'child prompt')

    expect(child.session.snapshotEvents().slice(0, child.session.inheritedEventCount)
      .some(event => event.type === 'request/header')).toBe(false)
    expect(routeOf(harness.adapter.requests[1])).toEqual({ provider: ROUTE, sessionId: child.id, cacheSessionId: parent.id })
    expect(picks(ownEvents(child))).toEqual([{ provider: ROUTE, model: MODEL }])
    expect(switchNotices(child.session.snapshotEvents())).toBe(0)
    expect(harness.saved).not.toHaveBeenCalled()
  })

  it('keeps a pick the cut inherited before any request instead of the first request route', async () => {
    const harness = await loopHarness(2)
    const parent = await harness.agents.create(SessionId('picked-source'), { provider: ROUTE, model: MODEL })
    const pick = parent.session.append('model/selection', { provider: ALIAS, model: MODEL })
    await runTurn(parent, 'first')

    const child = await fork(harness, { sessionId: parent.id, atSeq: pick.seq })
    await runTurn(child, 'child prompt')

    expect(harness.adapter.requests.map(request => request.provider)).toEqual([ROUTE, ALIAS])
    expect(picks(ownEvents(child))).toEqual([])
  })
})

/** Stored Session record served by the persistence double. */
interface StoredSession {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

function header(id: string, lineage: Partial<Pick<SessionHeader, 'parentSession' | 'origin'>> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, isSeeded: false, cwd: '/tmp', ...lineage }
}

interface ControllerHarness {
  readonly ctx: Context
  readonly controller: ApiSessionAgentController
  readonly stored: Map<SessionId, StoredSession>
  readonly created: AgentOptions[]
  readonly resumed: AgentOptions[]
}

/** The Agent controller over stored Sessions, recording the options of each Agent it creates or resumes. */
async function controllerHarness(options: { readonly persistence?: boolean } = {}): Promise<ControllerHarness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  const stored = new Map<SessionId, StoredSession>()
  if (options.persistence !== false) {
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([...stored.values()].map(record => record.header)),
      inspect: (id: SessionId) => {
        const record = stored.get(id)
        return Promise.resolve(record === undefined ? undefined : { meta: record.header, events: [...record.events] })
      },
    }) as never)
  }
  const created: AgentOptions[] = []
  const resumed: AgentOptions[] = []
  const publish = async (session: ReturnType<Context['sessions']['prepare']>) => {
    ctx.effect(function* () {
      yield ctx.sessions.enter(session)
      ctx.sessions.announce(session)
    }, 'test: published Session')
    const agent = { id: session.id, session, status: 'idle', ctx } as Agent
    const unregister = await ctx.agents.register(agent)
    return { agent, dispose: async () => { await unregister() } }
  }
  const factory: AgentFactory = {
    async createAgent(_ownerCtx, create) {
      created.push(create.agentOptions ?? {})
      return publish(ctx.sessions.prepare(create.sessionId, create.meta === undefined ? {} : { meta: create.meta }))
    },
    async resume(_ownerCtx, resume) {
      resumed.push(resume.agentOptions ?? {})
      const record = stored.get(resume.resumeSessionId)
      if (record === undefined) throw new Error(`no stored Session "${resume.resumeSessionId}"`)
      return publish(ctx.sessions.prepare(record.header.id, { meta: record.header, seed: [...record.events] }))
    },
  }
  ctx.agents.setFactory(factory)
  const controller = new ApiSessionAgentController(ctx)
  vi.spyOn(controller, 'composeAgent').mockImplementation(() => Promise.resolve({ setup: () => {} }))
  return { ctx, controller, stored, created, resumed }
}

function store(harness: ControllerHarness, record: SessionHeader, events: readonly SessionEvent[] = []): void {
  harness.stored.set(record.id, { header: record, events })
}

function startedTurn(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('fork-family root', () => {
  it('climbs live and stored fork parents to the root', async () => {
    const harness = await controllerHarness()
    harness.ctx.sessions.create(SessionId('live-middle'), { meta: { cwd: '/tmp', parentSession: SessionId('stored-root') } })
    store(harness, header('stored-root'))
    store(harness, header('stored-middle', { parentSession: SessionId('live-middle') }))

    await expect(harness.controller.forkFamilyRoot(header('leaf', { parentSession: SessionId('stored-middle') })))
      .resolves.toBe(SessionId('stored-root'))
    await expect(harness.controller.forkFamilyRoot(header('lone'))).resolves.toBe(SessionId('lone'))
  })

  it('stops at an ancestor that is absent, unreadable, or has no persistence service', async () => {
    const harness = await controllerHarness()
    store(harness, header('orphan-middle', { parentSession: SessionId('deleted-root') }))
    await expect(harness.controller.forkFamilyRoot(header('leaf', { parentSession: SessionId('orphan-middle') })))
      .resolves.toBe(SessionId('deleted-root'))

    const warn = vi.spyOn(harness.ctx.logger, 'warn').mockImplementation(() => {})
    vi.spyOn(harness.ctx.sessionPersistence, 'stat').mockRejectedValue(new Error('disk offline'))
    await expect(harness.controller.forkFamilyRoot(header('leaf', { parentSession: SessionId('unreadable') })))
      .resolves.toBe(SessionId('unreadable'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"unreadable" because its header could not be read: Error: disk offline'))

    const bare = await controllerHarness({ persistence: false })
    await expect(bare.controller.forkFamilyRoot(header('leaf', { parentSession: SessionId('elsewhere') })))
      .resolves.toBe(SessionId('elsewhere'))
  })

  it('roots a subagent child at itself and ends a repeated lineage', async () => {
    const harness = await controllerHarness()
    harness.ctx.sessions.create(SessionId('delegate'), {
      meta: { cwd: '/tmp', parentSession: SessionId('owner'), origin: 'subagent' },
    })
    store(harness, header('loop-a', { parentSession: SessionId('loop-b') }))
    store(harness, header('loop-b', { parentSession: SessionId('loop-a') }))

    await expect(harness.controller.forkFamilyRoot(header('delegate', { parentSession: SessionId('owner'), origin: 'subagent' })))
      .resolves.toBe(SessionId('delegate'))
    await expect(harness.controller.forkFamilyRoot(header('delegate-fork', { parentSession: SessionId('delegate') })))
      .resolves.toBe(SessionId('delegate'))
    await expect(harness.controller.forkFamilyRoot(header('self', { parentSession: SessionId('self') })))
      .resolves.toBe(SessionId('self'))
    await expect(harness.controller.forkFamilyRoot(header('loop-a', { parentSession: SessionId('loop-b') })))
      .resolves.toBe(SessionId('loop-b'))
  })

  it('keys a created Session by itself and a resumed or reused fork child by its root', async () => {
    const harness = await controllerHarness()
    store(harness, header('cold-root'), startedTurn())
    store(harness, header('cold-child', { parentSession: SessionId('cold-root') }), startedTurn())
    store(harness, header('blank-child', { parentSession: SessionId('cold-root') }))

    const created = await harness.controller.createSession({ cwd: '/tmp', reusable: () => true })
    const resumed = await harness.controller.resolveAgent(SessionId('cold-child'))
    const reused = await harness.controller.createSession({
      sessionId: SessionId('blank-child'), cwd: '/tmp', reusable: () => true,
    })

    expect('agent' in resumed).toBe(true)
    expect(reused.agent.id).toBe(SessionId('blank-child'))
    const defaultRoute = { provider: 'default-provider', model: 'default-model' }
    expect(harness.created).toEqual([{ ...defaultRoute, cacheSessionId: created.agent.id }])
    expect(harness.resumed).toEqual([
      { ...defaultRoute, cacheSessionId: SessionId('cold-root') },
      { ...defaultRoute, cacheSessionId: SessionId('cold-root') },
    ])
  })
})
