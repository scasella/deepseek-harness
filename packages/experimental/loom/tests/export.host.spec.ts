/** Owner download routing, immutable snapshots, output escaping and retention limits. */
import { Context } from '@deepseek-ai/cordis'
import { AssistantStreamAccumulator, createAssistantMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, SessionId } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { mountBranchHost } from './branch-host.ts'
import type { Config } from '../src/index.ts'
import type { LoomNodeId, LoomWeaveRequestRecord } from '../src/types.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const roots: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(config: Config = {}, connected = true) {
  const ctx = new Context()
  roots.push(ctx)
  const routes: { readonly path: string; readonly fetch: (request: Request) => Promise<Response> }[] = []
  const dispose = vi.fn()
  if (connected) ctx.provide('connection', { fetch: { register: (route: typeof routes[number]) => {
    routes.push(route)
    return () => { dispose() }
  } } } as never)
  const host = await mountBranchHost(ctx, { provider: 'mock', model: 'mock' }, config)
  const agent = await host.agents.create(SessionId('export-source'), { provider: 'mock', model: 'mock' })
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '<script>alert("story")</script>' }] }), { surfaceOp: 'append' })
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const fetch = async (url: string, method = 'GET') => {
    const route = routes.find(value => value.path === '/api/loom.export')
    if (route === undefined) throw new Error('Missing export route')
    return route.fetch(new Request(`http://localhost${url}`, { method }))
  }
  return { ctx, host, agent, fetch, dispose }
}

const signal = (): AbortSignal => new AbortController().signal
const sessionExport = z.object({ sessions: z.array(z.object({ sessionId: z.string(), messages: z.array(z.unknown()) })) })
const proseExport = z.object({
  nodes: z.array(z.object({ prefix: z.array(z.object({ text: z.string() })) })),
  curationBits: z.number(), choices: z.array(z.object({ nodeId: z.string() })),
})

describe('Loom export', () => {
  it('aborts and drains a pending snapshot before its connection is removed', async () => {
    const { ctx, host, agent, fetch, dispose } = await harness()
    const inspect = ctx.sessionController.inspect.bind(ctx.sessionController)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.sessionController, 'inspect').mockImplementationOnce(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return inspect(...args)
    })
    const pending = ctx.loom.export({ sessionId: agent.id, mode: 'path' }, signal())
    const rejected = expect(pending).rejects.toMatchObject({ code: 'loom/export-unavailable' })
    await entered.promise
    const teardown = host.loom.dispose()
    release.resolve(undefined)
    await rejected
    await teardown
    expect(dispose).toHaveBeenCalledOnce()
    expect((await fetch('/api/loom.export?token=never-created')).status).toBe(404)
  })

  it('downloads an immutable JSON path and releases its route on unload', async () => {
    const { ctx, host, agent, fetch, dispose } = await harness()
    const value = await ctx.loom.export({ sessionId: agent.id, mode: 'path' }, signal())
    agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'later edit' }] }), { surfaceOp: 'append' })
    const response = await fetch(value.url)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('content-disposition')).toContain(value.filename)
    const body = sessionExport.parse(await response.json())
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]?.messages[0]).toMatchObject({ content: [{ type: 'text', text: '<script>alert("story")</script>' }] })
    expect(JSON.stringify(body)).not.toContain('later edit')
    const head = await fetch(value.url, 'HEAD')
    expect(await head.text()).toBe('')
    expect(head.headers.get('content-length')).toBe(response.headers.get('content-length'))
    await host.loom.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    expect((await fetch(value.url)).status).toBe(404)
  })

  it('escapes HTML and keeps source records and curation in text exports', async () => {
    const { ctx, agent, fetch } = await harness()
    const html = await ctx.loom.export({ sessionId: agent.id, mode: 'path', format: 'html' }, signal())
    const markup = await (await fetch(html.url)).text()
    expect(markup).toContain('&lt;script&gt;')
    expect(markup).not.toContain('<script>')
    expect(markup).toContain('Curation and source records')
    const text = await ctx.loom.export({ sessionId: agent.id, mode: 'path', format: 'text' }, signal())
    const prose = await (await fetch(text.url)).text()
    expect(prose).toContain('user: <script>')
    expect(prose).toContain('Curation: 0 bits; 0 selected model tokens.')
    expect(prose).toContain('"events"')
  })

  it('exports sibling branches and only explicitly kept members of the full family', async () => {
    const { ctx, agent, fetch } = await harness()
    const first = await ctx.sessionController.fork({ sessionId: agent.id })
    const second = await ctx.sessionController.fork({ sessionId: first.sessionId })
    await ctx.loom.mark({ sessionId: second.sessionId, mark: 'keep' })
    const siblings = await ctx.loom.export({ sessionId: agent.id, mode: 'siblings' }, signal())
    expect(sessionExport.parse(await (await fetch(siblings.url)).json()).sessions.map(value => value.sessionId))
      .toEqual(expect.arrayContaining([agent.id, first.sessionId]))
    const kept = await ctx.loom.export({ sessionId: agent.id, mode: 'kept' }, signal())
    expect(sessionExport.parse(await (await fetch(kept.url)).json()).sessions.map(value => value.sessionId)).toEqual([second.sessionId])
  })

  it('refuses unavailable connections and oversize exports without retaining a partial result', async () => {
    const absent = await harness({}, false)
    await expect(absent.ctx.loom.export({ sessionId: absent.agent.id, mode: 'path' }, signal()))
      .rejects.toMatchObject({ code: 'loom/export-unavailable' })
    const tiny = await harness({ export: { maxBytes: 1 } })
    await expect(tiny.ctx.loom.export({ sessionId: tiny.agent.id, mode: 'path' }, signal()))
      .rejects.toMatchObject({ code: 'loom/export-unavailable' })
  })

  it('expires and evicts download snapshots under configured limits', async () => {
    const { ctx, agent, fetch } = await harness({ export: { maxDownloads: 1, ttlMs: 50 } })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const first = await ctx.loom.export({ sessionId: agent.id, mode: 'path' }, signal())
    const second = await ctx.loom.export({ sessionId: agent.id, mode: 'path' }, signal())
    expect((await fetch(first.url)).status).toBe(404)
    expect((await fetch(second.url)).status).toBe(200)
    clock.mockReturnValue(1050)
    expect((await fetch(second.url)).status).toBe(404)
    expect((await fetch('/api/loom.export')).status).toBe(404)
  })

  it('keeps reasoning in source records and handles absent catalogue families', async () => {
    const { ctx, agent, fetch } = await harness()
    agent.session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('') }, { surfaceOp: 'append' })
    agent.session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'mock', model: 'mock' },
      content: [{ type: 'reasoning', text: 'Internal reasoning' }, { type: 'text', text: 'Answer' }],
    }) }, { surfaceOp: 'append' })
    const path = await ctx.loom.export({ sessionId: agent.id, mode: 'path', format: 'text' }, signal())
    expect(await (await fetch(path.url)).text()).toContain('assistant: Answer')
    vi.spyOn(ctx.sessionController, 'list').mockResolvedValueOnce({ items: [] })
    const kept = await ctx.loom.export({ sessionId: agent.id, mode: 'kept' }, signal())
    expect(sessionExport.parse(await (await fetch(kept.url)).json()).sessions).toEqual([])
  })

  it('limits siblings to the focused fork cut', async () => {
    const { ctx, agent, fetch } = await harness()
    const first = await ctx.sessionController.fork({ sessionId: agent.id })
    const peer = await ctx.sessionController.fork({ sessionId: agent.id })
    agent.session.append('turn/start', { turn: 2 })
    agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'New turn' }] }), { surfaceOp: 'append' })
    agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const later = await ctx.sessionController.fork({ sessionId: agent.id })
    const value = await ctx.loom.export({ sessionId: first.sessionId, mode: 'siblings' }, signal())
    const exported = sessionExport.parse(await (await fetch(value.url)).json()).sessions.map(item => item.sessionId)
    expect(exported).toEqual(expect.arrayContaining([first.sessionId, peer.sessionId]))
    expect(exported).not.toContain(later.sessionId)
  })

  it('exports exact prose prefixes, siblings and kept choices with their curation record', async () => {
    const { ctx, agent, fetch } = await harness()
    const request: LoomWeaveRequestRecord = {
      version: 1, parentNode: null, n: 2, config: { provider: 'mock', model: 'mock' }, topLogprobs: 0,
      system: 'Prose', messages: [{ role: 'user', content: [{ type: 'text', text: 'Continue.' }] }],
      assistantPrefix: 'Authored ', prefixSpans: [{ text: 'Authored ', author: 'user' }], stop: [], schedule: 'burst', kind: 'weave',
    }
    const requestSeq = appendPluginRecord(agent.session, 'plugin:loom/weave-request', request)
    const ids = [brandString<LoomNodeId>('first-prose'), brandString<LoomNodeId>('second-prose')]
    for (const [index, id] of ids.entries()) {
      const accumulator = new AssistantStreamAccumulator()
      for (const chunk of textResponse(index === 0 ? 'first' : 'second')) accumulator.push({ time: 0, chunk })
      appendPluginRecord(agent.session, 'plugin:loom/weave-node', { version: 1, id, requestSeq, index, kind: 'weave', stream: accumulator.snapshot() })
    }
    appendPluginRecord(agent.session, 'plugin:loom/choice', { version: 1, nodeId: ids[0]!, requestSeq, alternatives: 2 })
    for (const mode of ['path', 'siblings', 'kept'] as const) {
      const value = await ctx.loom.export({ sessionId: agent.id, nodeId: ids[0]!, mode }, signal())
      const body = proseExport.parse(await (await fetch(value.url)).json())
      expect(body.nodes).toHaveLength(mode === 'siblings' ? 2 : 1)
      expect(body).toHaveProperty('nodes.0.prefix.0.text', 'Authored ')
      expect(body.curationBits).toBe(1)
      expect(body).toHaveProperty('choices.0.nodeId', ids[0])
    }
    await expect(ctx.loom.export({ sessionId: agent.id, nodeId: brandString<LoomNodeId>('absent'), mode: 'path' }, signal()))
      .rejects.toMatchObject({ code: 'loom/node-not-found' })
    expect(requestSeq).toEqual(expect.any(Number))
  })
})
