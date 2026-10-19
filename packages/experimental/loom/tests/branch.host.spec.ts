/**
 * `loom.branch`, `loom.setStatus`, `loom.cancel`, and `loom.mark` over a real
 * agent loop and the real Session Controller fork: cuts, inherited queued
 * input, branch records before prompts, lazy admission, failures, teardown,
 * and private marks.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access'
import {
  ApiSessionNotFound,
  completedPrefixBefore,
  inheritedNextTurnPrompts,
  latestCompletedPrefixBoundary,
  type SessionRequestId,
} from '@deepseek-ai/dsh-api-session-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  createUserMessage,
  LlmAdapter,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type MessageSource,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { pluginRecordOf, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { RemoteError, type PeerId, type Principal, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { variantKeyOf } from '../src/branch-spec.ts'
import { mountBranchHost, type BranchHost, type TestWorkspace } from './branch-host.ts'
import type { Config } from '../src/index.ts'
import type { LoomBranchRequest, LoomBranchRequestId, LoomBranchValue, LoomSetId } from '../src/types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Test-only automation prompt that opens a turn without a user. */
    'loom-test-automation': { kind: 'loom-test-automation' }
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller of the Loom Remote. */
    'loom-test-guest': { readonly kind: 'loom-test-guest' }
  }
}

const roots: Context[] = []
const stores: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
  await Promise.all(stores.splice(0).map(store => rm(store, { recursive: true, force: true })))
})

const GUEST: Principal = { kind: 'loom-test-guest' }
/** Any child Session id. */
const ANY_SESSION = expect.any(String) as SessionId
const FOLDER = '/tmp/loom-branch'

/** Text of the last user message of a request. */
function lastUserText(options: GenerateOptions): string {
  return textOf(options.messages.findLast(message => message.role === 'user')?.content ?? [])
}

/** Answers every request with its last user text; while `gated`, each request waits until its Session is opened. */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  gated = false
  private readonly waiting = new Map<string, () => void>()

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(['mock', 'alternate'].map(id => ({ provider, id, name: id })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.gated) {
      await new Promise<void>((resolve, reject) => {
        this.waiting.set(String(options.sessionId), resolve)
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
    }
    yield * textResponse(`reply: ${lastUserText(options)}`)
  }

  /** Sessions whose request waits at the gate. */
  held(): string[] {
    return [...this.waiting.keys()]
  }

  /** Let the waiting request of one Session answer. */
  open(sessionId: string): void {
    const resolve = this.waiting.get(sessionId)
    if (resolve === undefined) throw new Error(`no request of ${sessionId} waits`)
    this.waiting.delete(sessionId)
    resolve()
  }

  /** Stop gating and answer every waiting request. */
  release(): void {
    this.gated = false
    for (const sessionId of this.held()) this.open(sessionId)
  }
}

interface Harness {
  readonly ctx: Context
  readonly agents: AgentLoopTestHarness
  readonly adapter: GatedAdapter
  readonly workspaces: TestWorkspace[]
  readonly loom: BranchHost['loom']
}

async function harness(config: Config = {}, persistenceRoot?: string): Promise<Harness> {
  const ctx = new Context()
  roots.push(ctx)
  const host = await mountBranchHost(ctx, { provider: 'mock', model: 'mock' }, config, persistenceRoot)
  const adapter = new GatedAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter, ...host }
}

function prompt(text: string, source: MessageSource = { kind: 'user' }) {
  return createUserMessage({ content: [{ type: 'text', text }], source })
}

let sourceCount = 0
async function source(
  h: Harness,
  options: { readonly folder?: string | null; readonly mode?: 'read-only' | 'workspace-write' } = {},
): Promise<Agent> {
  sourceCount += 1
  const folder = options.folder === undefined ? FOLDER : options.folder
  const agent = await h.agents.create(SessionId(`loom-source-${String(sourceCount)}`), { provider: 'mock', model: 'mock' }, folder === null ? {} : { cwd: folder })
  if (options.mode !== undefined) setSandboxMode(agent.session, options.mode)
  return agent
}

async function run(agent: Agent, ...texts: string[]): Promise<void> {
  for (const text of texts) agent.followup(prompt(text))
  await agent.whenIdle()
}

/** The harness Context as seen by a Remote call of `method` from the test guest. */
function asGuest(h: Harness, method: string): Context {
  const invocation: RemoteInvocation = {
    request: { namespace: 'loom', method, args: {} },
    service: 'loom',
    peer: { id: 'loom-access-peer' as PeerId, ctx: h.ctx, principal: GUEST, interactions: 'answer', signal: new AbortController().signal, dispose: async () => {} },
    signal: new AbortController().signal,
    uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
  }
  return h.ctx.extend({ invocation })
}

let requestCount = 0
function requestId(): LoomBranchRequestId {
  requestCount += 1
  return brandString<LoomBranchRequestId>(`request-${String(requestCount)}`)
}

async function eventsOf(h: Harness, sessionId: SessionId): Promise<readonly SessionEvent[]> {
  return (await h.ctx.sessionController.inspect(sessionId)).events
}

function started(value: LoomBranchValue): SessionId[] {
  return value.children.flatMap(child => child.state === 'started' ? [child.sessionId] : [])
}

function child(h: Harness, sessionId: SessionId): Agent {
  const agent = h.ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error(`child ${sessionId} is not live`)
  return agent
}

/** Text parts of a message, one per line. */
function textOf(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** Texts of the user messages a Session wrote itself. */
function ownUserTexts(events: readonly SessionEvent[], inheritedEventCount: number): string[] {
  return events.flatMap(event => event.type === 'user/message' && event.seq >= inheritedEventCount ? [textOf(event.data.content)] : [])
}

describe('loom.branch', () => {
  it('regenerates a turn into children cut before its opening prompt, each holding its record before its prompt', async () => {
    const h = await harness()
    const root = await source(h, { mode: 'read-only' })
    await run(root, 'first')
    await run(root, 'second')
    const sourceEvents = await eventsOf(h, root.id)
    const cut = completedPrefixBefore(sourceEvents, 2)!
    const id = requestId()
    const value = await h.ctx.loom.branch({ sessionId: root.id, requestId: id, kind: 'regenerate', turn: 2, count: 2 })
    expect(value.children.map(entry => entry.state)).toEqual(['started', 'started'])
    const opening = sourceEvents.find((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && textOf(event.data.content) === 'second')!
    for (const [index, sessionId] of started(value).entries()) {
      const agent = child(h, sessionId)
      await agent.whenIdle()
      const events = await eventsOf(h, sessionId)
      const { inheritedEventCount } = agent.session
      expect(agent.session.header.parentSession).toBe(root.id)
      expect(inheritedEventCount).toBe(cut + 1)
      expect(ownUserTexts(events, 0)).toEqual(['first', 'second'])
      const own = events.slice(inheritedEventCount)
      const recordAt = own.findIndex(event => pluginRecordOf(event)?.type === 'plugin:loom/branch')
      const promptAt = own.findIndex(event => event.type === 'user/message')
      expect(recordAt).toBeGreaterThanOrEqual(0)
      expect(recordAt).toBeLessThan(promptAt)
      expect(own[recordAt]!.data).toEqual({ version: 1, setId: value.setId, sourceSessionId: root.id, atSeq: cut, kind: 'regenerate', index })
      const message = own[promptAt]! as SessionEvent<'user/message'>
      expect(message.data.content).toEqual(opening.data.content)
      expect(message.data.source).toEqual({ kind: 'user', rpcId: `${id}/${String(index)}` })
      expect(own.filter(event => event.type === 'turn/end')).toHaveLength(1)
      expect(h.ctx.sessionProjections.snapshot(agent.session).values.loomBranch)
        .toEqual({ setId: value.setId, kind: 'regenerate', index, createdAt: own[recordAt]!.time })
      expect(h.adapter.requests.find(request => request.sessionId === sessionId)).toMatchObject({ provider: 'mock', model: 'mock' })
    }
    expect(await eventsOf(h, root.id)).toEqual(sourceEvents)
    expect(h.ctx.sessionProjections.snapshot(root.session).values.loomBranch).toBeNull()
  })

  it('removes prompts the child inherited as queued input, so only its own prompt runs', async () => {
    const h = await harness()
    const root = await source(h)
    await run(root, 'one', 'two', 'three')
    const sourceEvents = await eventsOf(h, root.id)
    const cut = completedPrefixBefore(sourceEvents, 2)!
    expect(inheritedNextTurnPrompts(sourceEvents, cut).map(message => textOf(message.content))).toEqual(['two', 'three'])
    const value = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'regenerate', turn: 2, count: 1 })
    const [sessionId] = started(value)
    const agent = child(h, sessionId!)
    await agent.whenIdle()
    expect(agent.inbox.nextTurn).toEqual([])
    const events = await eventsOf(h, sessionId!)
    expect(ownUserTexts(events, agent.session.inheritedEventCount)).toEqual(['two'])
    expect(events.slice(agent.session.inheritedEventCount).filter(event => event.type === 'turn/start')).toHaveLength(1)
  })

  it('regenerates turn 1 from the standalone events before the first prompt, and refuses a log without them', async () => {
    const h = await harness()
    const root = await source(h, { mode: 'workspace-write' })
    await run(root, 'first')
    const value = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'regenerate', turn: 1, count: 1 })
    const agent = child(h, started(value)[0]!)
    await agent.whenIdle()
    expect(agent.session.inheritedEventCount).toBe(1)
    expect(ownUserTexts(await eventsOf(h, agent.id), 0)).toEqual(['first'])

    const bare = await source(h)
    await run(bare, 'first')
    await expect(h.ctx.loom.branch({ sessionId: bare.id, requestId: requestId(), kind: 'regenerate', turn: 1, count: 1 }))
      .rejects.toMatchObject({ code: 'loom/turn-unavailable', details: { sessionId: bare.id, turn: 1, reason: 'no-cut' } })
  })

  it('steers after a turn, cut at its end whether or not a later turn exists', async () => {
    const h = await harness()
    const root = await source(h)
    await run(root, 'first')
    await run(root, 'second')
    const sourceEvents = await eventsOf(h, root.id)
    const middle = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines: ['left', 'right'] })
    const last = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'steer', afterTurn: 2, lines: ['up'] })
    for (const [value, cut, texts] of [
      [middle, completedPrefixBefore(sourceEvents, 2)!, ['left', 'right']],
      [last, latestCompletedPrefixBoundary(sourceEvents)!, ['up']],
    ] as const) {
      for (const [index, sessionId] of started(value).entries()) {
        const agent = child(h, sessionId)
        await agent.whenIdle()
        expect(agent.session.inheritedEventCount).toBe(cut + 1)
        expect(ownUserTexts(await eventsOf(h, sessionId), cut + 1)).toEqual([texts[index]])
      }
    }
    expect(h.adapter.requests.filter(request => request.sessionId === root.id).map(lastUserText)).toEqual(['first', 'second'])
  })

  it('edits the opening prompt of a turn into one child', async () => {
    const h = await harness()
    const root = await source(h)
    await run(root, 'first')
    await run(root, 'second')
    const value = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'edit', turn: 2, text: 'second, edited' })
    const agent = child(h, started(value)[0]!)
    await agent.whenIdle()
    expect(ownUserTexts(await eventsOf(h, agent.id), agent.session.inheritedEventCount)).toEqual(['second, edited'])
    expect(h.ctx.sessionProjections.snapshot(agent.session).values.loomBranch).toMatchObject({ kind: 'edit', index: 0 })
  })

  it('samples each variant line, every sample of one line sharing a variant key', async () => {
    const h = await harness()
    const root = await source(h, { mode: 'read-only' })
    await run(root, 'first')
    const value = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'variants', afterTurn: 1, lines: ['a', 'b'], samples: 2 })
    expect(value.children.map(entry => entry.index)).toEqual([0, 1, 2, 3])
    const views = started(value).map(sessionId => h.ctx.sessionProjections.snapshot(child(h, sessionId).session).values.loomBranch)
    expect(views.map(view => [view?.index, view?.variantKey])).toEqual([
      [0, variantKeyOf('a')], [1, variantKeyOf('a')], [2, variantKeyOf('b')], [3, variantKeyOf('b')],
    ])
    for (const [index, sessionId] of started(value).entries()) {
      const agent = child(h, sessionId)
      await agent.whenIdle()
      expect(ownUserTexts(await eventsOf(h, sessionId), agent.session.inheritedEventCount)).toEqual([index < 2 ? 'a' : 'b'])
    }
  })

  it('returns the first result for a retried request and creates nothing', async () => {
    const h = await harness()
    const root = await source(h, { mode: 'read-only' })
    await run(root, 'first')
    const request: LoomBranchRequest = { sessionId: root.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines: ['x'] }
    const fork = vi.spyOn(h.ctx.sessionController, 'fork')
    const first = await h.ctx.loom.branch(request)
    const sessions = h.ctx.sessions.list().length
    await expect(h.ctx.loom.branch({ ...request, lines: ['different'] })).resolves.toBe(first)
    expect(h.ctx.sessions.list()).toHaveLength(sessions)
    expect(fork).toHaveBeenCalledTimes(1)

    // A rejected request created nothing, so its retry is resolved again.
    const invalid: LoomBranchRequest = { sessionId: root.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines: [' '] }
    await expect(h.ctx.loom.branch(invalid)).rejects.toMatchObject({ code: 'loom/empty-line' })
    await expect(h.ctx.loom.branch({ ...invalid, lines: ['fixed'] })).resolves.toMatchObject({ children: [{ state: 'started' }] })
  })

  it('raises every validation failure before any fork', async () => {
    const h = await harness()
    const root = await source(h)
    await run(root, 'first')
    root.followup(prompt('automated', { kind: 'loom-test-automation' }))
    await root.whenIdle()
    h.adapter.gated = true
    root.followup(prompt('running'))
    await vi.waitFor(() => { expect(h.adapter.held()).toEqual([root.id]) })
    const fork = vi.spyOn(h.ctx.sessionController, 'fork')
    const base = { sessionId: root.id, requestId: requestId() }
    const cases: readonly [LoomBranchRequest, object][] = [
      [{ ...base, kind: 'regenerate', turn: 1, count: 0 }, { code: 'gateway/bad-request' }],
      [{ ...base, kind: 'regenerate', turn: 1, count: 1.5 }, { code: 'gateway/bad-request' }],
      [{ ...base, kind: 'variants', afterTurn: 1, lines: ['a'], samples: 0 }, { code: 'gateway/bad-request' }],
      [{ ...base, kind: 'steer', afterTurn: 1, lines: [] }, { code: 'gateway/bad-request' }],
      [{ ...base, kind: 'regenerate', turn: 1, count: 9 }, { code: 'loom/too-many-branches', details: { requested: 9, limit: 8 } }],
      [{ ...base, kind: 'variants', afterTurn: 1, lines: ['a', 'b', 'c'], samples: 3 }, { code: 'loom/too-many-branches', details: { requested: 9, limit: 8 } }],
      [{ ...base, kind: 'steer', afterTurn: 1, lines: ['a', '\n '] }, { code: 'loom/empty-line', details: { index: 1 } }],
      [{ ...base, kind: 'edit', turn: 1, text: ' ' }, { code: 'loom/empty-line', details: { index: 0 } }],
      [{ ...base, kind: 'regenerate', turn: 9, count: 1 }, { code: 'loom/turn-unavailable', details: { turn: 9, reason: 'not-found' } }],
      [{ ...base, kind: 'regenerate', turn: 2, count: 1 }, { code: 'loom/turn-unavailable', details: { turn: 2, reason: 'not-user-opened' } }],
      [{ ...base, kind: 'steer', afterTurn: 9, lines: ['a'] }, { code: 'loom/turn-unavailable', details: { turn: 9, reason: 'not-found' } }],
      [{ ...base, kind: 'steer', afterTurn: 3, lines: ['a'] }, { code: 'loom/turn-unavailable', details: { turn: 3, reason: 'not-ended' } }],
      [{ ...base, sessionId: SessionId('missing'), kind: 'steer', afterTurn: 1, lines: ['a'] }, { code: 'session/not-found', details: { sessionId: 'missing' } }],
    ]
    for (const [request, failure] of cases) {
      await expect(h.ctx.loom.branch(request), JSON.stringify(request)).rejects.toMatchObject(failure)
    }
    expect(fork).not.toHaveBeenCalled()
    h.adapter.release()
    await root.whenIdle()
  })

  it('records the source prompt time zone and the requested route on every child', async () => {
    const h = await harness()
    const root = await source(h, { mode: 'read-only' })
    const rpc = (text: string, clientTimeZone: string): MessageSource => ({
      kind: 'user', rpcId: brandString<SessionRequestId>(`source-${text}`), clientTimeZone,
    })
    root.followup(prompt('first', rpc('first', 'Europe/Paris')))
    await root.whenIdle()
    root.followup(prompt('second', rpc('second', 'Asia/Tokyo')))
    await root.whenIdle()
    const fork = vi.spyOn(h.ctx.sessionController, 'fork')
    const selection = { provider: 'mock', model: 'alternate' }
    const regenerate = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'regenerate', turn: 1, count: 1 })
    const steer = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'steer', afterTurn: 2, lines: ['next'], selection })
    expect(fork).toHaveBeenLastCalledWith(expect.objectContaining({ selection }))
    for (const [value, zone] of [[regenerate, 'Europe/Paris'], [steer, 'Asia/Tokyo']] as const) {
      const agent = child(h, started(value)[0]!)
      await agent.whenIdle()
      // A route override adds the model-switch notice after the prompt, so the prompt is the last user-sourced message.
      const message = (await eventsOf(h, agent.id))
        .findLast(event => event.type === 'user/message' && event.data.source.kind === 'user') as SessionEvent<'user/message'>
      expect(message.data.source).toMatchObject({ kind: 'user', clientTimeZone: zone })
    }
    expect(h.adapter.requests.findLast(request => request.sessionId === started(steer)[0])?.model).toBe('alternate')
  })

  it('treats children of a Session without a folder as sharing one folder', async () => {
    const h = await harness()
    const root = await source(h, { folder: null })
    await run(root, 'first')
    h.adapter.gated = true
    const value = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines: ['a', 'b'] })
    expect(value.children.map(entry => entry.state)).toEqual(['started', 'queued'])
    await vi.waitFor(() => { expect(h.adapter.held()).toHaveLength(1) })
    h.adapter.release()
    await vi.waitFor(() => { expect(h.ctx.loom.setStatus({ setId: value.setId }).children[1]).toMatchObject({ state: 'started' }) })
  })

  it('propagates a source read failure that is not a missing Session', async () => {
    const h = await harness()
    const failure = new Error('disk unavailable')
    vi.spyOn(h.ctx.sessionController, 'inspect').mockRejectedValueOnce(failure)
    await expect(h.ctx.loom.branch({ sessionId: SessionId('any'), requestId: requestId(), kind: 'steer', afterTurn: 1, lines: ['a'] }))
      .rejects.toBe(failure)
  })
})

describe('loom.branch on a fork', () => {
  /** A read-only root with two turns and an edit of its turn 2, the fork whose first own turn is turn 2. */
  async function editedFork(
    h: Harness,
    selection?: { readonly provider: string; readonly model: string },
  ): Promise<{ readonly root: Agent; readonly fork: Agent; readonly cut: number }> {
    const root = await source(h, { mode: 'read-only' })
    await run(root, 'first')
    await run(root, 'second')
    const value = await h.ctx.loom.branch({
      sessionId: root.id, requestId: requestId(), kind: 'edit', turn: 2, text: 'second, edited', ...selection === undefined ? {} : { selection },
    })
    const fork = child(h, started(value)[0]!)
    await fork.whenIdle()
    return { root, fork, cut: completedPrefixBefore(await eventsOf(h, root.id), 2)! }
  }

  /** Routes a Session's own events select, in log order. */
  async function ownRoutes(h: Harness, agent: Agent): Promise<unknown[]> {
    return (await eventsOf(h, agent.id)).slice(agent.session.inheritedEventCount).flatMap(event => event.type === 'model/selection' ? [event.data] : [])
  }

  it('regenerates and edits a fork\'s first own turn into variants beside the fork, from its parent at its cut', async () => {
    const h = await harness()
    const { root, fork, cut } = await editedFork(h)
    const rootEvents = await eventsOf(h, root.id)
    const forkEvents = await eventsOf(h, fork.id)
    const forkSet = h.ctx.sessionProjections.snapshot(fork.session).values.loomBranch?.setId
    const lineage = h.ctx.sessionProjections.snapshot(fork.session).values.forkLineage
    const regenerated = await h.ctx.loom.branch({ sessionId: fork.id, requestId: requestId(), kind: 'regenerate', turn: 2, count: 2 })
    const edited = await h.ctx.loom.branch({ sessionId: fork.id, requestId: requestId(), kind: 'edit', turn: 2, text: 'second, again' })
    expect(regenerated.setId).not.toBe(forkSet)
    for (const [value, kind, text] of [[regenerated, 'regenerate', 'second, edited'], [edited, 'edit', 'second, again']] as const) {
      expect(h.ctx.loom.setStatus({ setId: value.setId }).sourceSessionId).toBe(root.id)
      for (const [index, sessionId] of started(value).entries()) {
        const sibling = child(h, sessionId)
        await sibling.whenIdle()
        expect(sibling.session.header.parentSession).toBe(root.id)
        expect(sibling.session.inheritedEventCount).toBe(cut + 1)
        const own = (await eventsOf(h, sessionId)).slice(cut + 1)
        expect(own.find(event => pluginRecordOf(event)?.type === 'plugin:loom/branch')?.data)
          .toEqual({ version: 1, setId: value.setId, sourceSessionId: root.id, atSeq: cut, kind, index })
        expect(ownUserTexts(own, 0)).toEqual([text])
        // The same parent and cut as the fork, which the pager groups variants by.
        expect(h.ctx.sessionProjections.snapshot(sibling.session).values.forkLineage)
          .toEqual({ ...lineage, createdAt: expect.any(Number) as number })
      }
    }
    expect(started(regenerated)).toHaveLength(2)
    expect(await eventsOf(h, root.id)).toEqual(rootEvents)
    expect(await eventsOf(h, fork.id)).toEqual(forkEvents)
  })

  it('runs first-own-turn variants on the route the fork selected, unless the request names one', async () => {
    const h = await harness()
    const alternate = { provider: 'mock', model: 'alternate' }
    const { fork } = await editedFork(h, alternate)
    expect(await ownRoutes(h, fork)).toEqual([alternate])
    const forkCall = vi.spyOn(h.ctx.sessionController, 'fork')
    const inherited = await h.ctx.loom.branch({ sessionId: fork.id, requestId: requestId(), kind: 'regenerate', turn: 2, count: 1 })
    expect(forkCall).toHaveBeenLastCalledWith(expect.objectContaining({ selection: alternate }))
    const named = { provider: 'mock', model: 'mock' }
    const overridden = await h.ctx.loom.branch({ sessionId: fork.id, requestId: requestId(), kind: 'edit', turn: 2, text: 'again', selection: named })
    expect(forkCall).toHaveBeenLastCalledWith(expect.objectContaining({ selection: named }))
    for (const [value, model] of [[inherited, 'alternate'], [overridden, 'mock']] as const) {
      const sibling = child(h, started(value)[0]!)
      await sibling.whenIdle()
      expect(h.adapter.requests.findLast(request => request.sessionId === sibling.id)?.model).toBe(model)
    }
  })

  it('gives first-own-turn variants of a turn-1 fork the same recorded route and prompt as the fork', async () => {
    const h = await harness()
    const root = await source(h, { mode: 'workspace-write' })
    await run(root, 'first')
    const value = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'regenerate', turn: 1, count: 1 })
    const fork = child(h, started(value)[0]!)
    await fork.whenIdle()
    const siblings = await h.ctx.loom.branch({ sessionId: fork.id, requestId: requestId(), kind: 'regenerate', turn: 1, count: 1 })
    const sibling = child(h, started(siblings)[0]!)
    await sibling.whenIdle()
    expect(sibling.session.header.parentSession).toBe(root.id)
    expect(await ownRoutes(h, fork)).toEqual([{ provider: 'mock', model: 'mock' }])
    expect(await ownRoutes(h, sibling)).toEqual(await ownRoutes(h, fork))
    expect(ownUserTexts(await eventsOf(h, sibling.id), sibling.session.inheritedEventCount))
      .toEqual(ownUserTexts(await eventsOf(h, fork.id), fork.session.inheritedEventCount))
  })

  it('branches a later turn of a fork into children of the fork', async () => {
    const h = await harness()
    const { fork } = await editedFork(h)
    await run(fork, 'third')
    const cut = completedPrefixBefore(await eventsOf(h, fork.id), 3)!
    const value = await h.ctx.loom.branch({ sessionId: fork.id, requestId: requestId(), kind: 'regenerate', turn: 3, count: 1 })
    const branch = child(h, started(value)[0]!)
    await branch.whenIdle()
    expect(branch.session.header.parentSession).toBe(fork.id)
    expect(branch.session.inheritedEventCount).toBe(cut + 1)
    expect(h.ctx.loom.setStatus({ setId: value.setId }).sourceSessionId).toBe(fork.id)
    expect(ownUserTexts(await eventsOf(h, branch.id), cut + 1)).toEqual(['third'])
  })

  describe('when the fork parent no longer exists', () => {
    /** Make every read of `parent` report a missing Session, as a deleted Session does. */
    function withoutParent(h: Harness, parent: Agent, failure?: Error): void {
      const inspect = h.ctx.sessionController.inspect.bind(h.ctx.sessionController)
      vi.spyOn(h.ctx.sessionController, 'inspect').mockImplementation(async (sessionId, signal) => {
        if (sessionId !== parent.id) return inspect(sessionId, signal)
        throw failure ?? new ApiSessionNotFound(`session "${sessionId}" not found`)
      })
    }

    it('cuts a first-own-turn regenerate and edit in the fork, below it, and resends the fork\'s own prompt', async () => {
      const h = await harness()
      const { root, fork } = await editedFork(h)
      withoutParent(h, root)
      const forkEvents = await eventsOf(h, fork.id)
      const cut = completedPrefixBefore(forkEvents, 2)!
      const forkCall = vi.spyOn(h.ctx.sessionController, 'fork')
      const regenerated = await h.ctx.loom.branch({ sessionId: fork.id, requestId: requestId(), kind: 'regenerate', turn: 2, count: 2 })
      const edited = await h.ctx.loom.branch({ sessionId: fork.id, requestId: requestId(), kind: 'edit', turn: 2, text: 'second, again' })
      expect(forkCall).toHaveBeenCalledTimes(3)
      for (const [value, kind, text] of [[regenerated, 'regenerate', 'second, edited'], [edited, 'edit', 'second, again']] as const) {
        expect(h.ctx.loom.setStatus({ setId: value.setId }).sourceSessionId).toBe(fork.id)
        for (const [index, sessionId] of started(value).entries()) {
          const branch = child(h, sessionId)
          await branch.whenIdle()
          expect(branch.session.header.parentSession).toBe(fork.id)
          expect(branch.session.inheritedEventCount).toBe(cut + 1)
          const own = (await eventsOf(h, sessionId)).slice(cut + 1)
          expect(own.find(event => pluginRecordOf(event)?.type === 'plugin:loom/branch')?.data)
            .toEqual({ version: 1, setId: value.setId, sourceSessionId: fork.id, atSeq: cut, kind, index })
          expect(ownUserTexts(own, 0)).toEqual([text])
        }
      }
      for (const [call] of forkCall.mock.calls) expect(call).toEqual({ sessionId: fork.id, atSeq: cut })
      expect(await eventsOf(h, fork.id)).toEqual(forkEvents)
    })

    it('fails on a parent read failure that is not a missing Session, before any fork', async () => {
      const h = await harness()
      const { root, fork } = await editedFork(h)
      const failure = new Error('disk unavailable')
      withoutParent(h, root, failure)
      const forkCall = vi.spyOn(h.ctx.sessionController, 'fork')
      await expect(h.ctx.loom.branch({ sessionId: fork.id, requestId: requestId(), kind: 'regenerate', turn: 2, count: 1 }))
        .rejects.toBe(failure)
      expect(forkCall).not.toHaveBeenCalled()
    })
  })

  it('requires branch access to the fork parent it branches, and checks set access through the Session the request named', async () => {
    const h = await harness()
    const { root, fork } = await editedFork(h)
    const bindings: RemoteAccessBinding[] = [{
      role: { name: 'loom-test:fork', resource: 'session', actions: ['loom/branch', 'loom/setStatus'] },
      resource: { kind: 'session', id: fork.id },
    }]
    h.ctx.remoteAccess.registerPolicy('loom-test-guest', { bindings: () => bindings })
    const forkCall = vi.spyOn(h.ctx.sessionController, 'fork')
    const request = { sessionId: fork.id, kind: 'regenerate', turn: 2, count: 1 } as const
    await expect(asGuest(h, 'branch').loom.branch({ ...request, requestId: requestId() }))
      .rejects.toMatchObject({ code: 'remote-access/denied', details: { action: 'loom/branch', reason: 'no-allow' } })
    expect(forkCall).not.toHaveBeenCalled()
    // A later turn is cut in the fork itself, which the Gateway authorized.
    await run(fork, 'third')
    const later = await asGuest(h, 'branch').loom.branch({ ...request, turn: 3, requestId: requestId() })
    await child(h, started(later)[0]!).whenIdle()

    bindings.push({
      role: { name: 'loom-test:parent', resource: 'session', actions: ['loom/branch'] },
      resource: { kind: 'session', id: root.id },
    })
    const value = await asGuest(h, 'branch').loom.branch({ ...request, requestId: requestId() })
    await child(h, started(value)[0]!).whenIdle()
    const guest = asGuest(h, 'setStatus')
    expect(guest.remoteAccess.allows({ kind: 'session', id: root.id })).toBe(false)
    expect(guest.loom.setStatus({ setId: value.setId }).sourceSessionId).toBe(root.id)
  })
})

describe('branch admission', () => {
  it('admits children in request order under maxConcurrentBranches and withdraws queued ones', async () => {
    const h = await harness({ maxConcurrentBranches: 1, concurrentWritableBranches: true })
    const root = await source(h)
    await run(root, 'first')
    h.adapter.gated = true
    const value = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines: ['a', 'b', 'c'] })
    expect(value.children).toEqual([
      { index: 0, state: 'started', sessionId: ANY_SESSION },
      { index: 1, state: 'queued' },
      { index: 2, state: 'queued' },
    ])
    const later = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines: ['d'] })
    expect(later.children).toEqual([{ index: 0, state: 'queued' }])
    const [first] = started(value)
    await vi.waitFor(() => { expect(h.adapter.held()).toEqual([first]) })
    h.adapter.open(first!)
    await vi.waitFor(() => { expect(h.ctx.loom.setStatus({ setId: value.setId }).children[1]).toMatchObject({ state: 'started' }) })
    const status = h.ctx.loom.setStatus({ setId: value.setId })
    expect(status).toEqual({
      setId: value.setId,
      sourceSessionId: root.id,
      children: [
        { index: 0, state: 'started', sessionId: first },
        { index: 1, state: 'started', sessionId: ANY_SESSION },
        { index: 2, state: 'queued' },
      ],
    })
    expect(h.ctx.loom.cancel({ setId: value.setId, indices: [0, 2] })).toEqual({ cancelled: [2] })
    expect(h.ctx.loom.cancel({ setId: value.setId })).toEqual({ cancelled: [] })
    const second = status.children[1]!.sessionId!
    await vi.waitFor(() => { expect(h.adapter.held()).toEqual([second]) })
    h.adapter.open(second)
    // The cancelled child is skipped; the next set's child takes the slot.
    await vi.waitFor(() => { expect(h.ctx.loom.setStatus({ setId: later.setId }).children[0]).toMatchObject({ state: 'started' }) })
    expect(h.ctx.loom.setStatus({ setId: value.setId }).children[2]).toEqual({ index: 2, state: 'cancelled' })
    const third = h.ctx.loom.setStatus({ setId: later.setId }).children[0]!.sessionId!
    await vi.waitFor(() => { expect(h.adapter.held()).toEqual([third]) })
    h.adapter.open(third)
    await child(h, third).whenIdle()
    const order = [first!, second, third]
      .map(sessionId => h.ctx.sessionProjections.snapshot(child(h, sessionId).session).values.loomBranch?.createdAt ?? 0)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('reports a child being admitted as queued and lets it finish when its set is cancelled', async () => {
    const h = await harness({ maxConcurrentBranches: 1 })
    const root = await source(h, { mode: 'read-only' })
    await run(root, 'first')
    h.adapter.gated = true
    const value = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines: ['a', 'b'] })
    const fork = h.ctx.sessionController.fork.bind(h.ctx.sessionController)
    const gate = Promise.withResolvers<undefined>()
    const spy = vi.spyOn(h.ctx.sessionController, 'fork').mockImplementation(async (request) => {
      await gate.promise
      return fork(request)
    })
    await vi.waitFor(() => { expect(h.adapter.held()).toHaveLength(1) })
    h.adapter.release()
    await vi.waitFor(() => { expect(spy).toHaveBeenCalledTimes(1) })
    expect(h.ctx.loom.setStatus({ setId: value.setId }).children[1]).toEqual({ index: 1, state: 'queued' })
    expect(h.ctx.loom.cancel({ setId: value.setId })).toEqual({ cancelled: [] })
    gate.resolve(undefined)
    await vi.waitFor(() => { expect(h.ctx.loom.setStatus({ setId: value.setId }).children[1]).toMatchObject({ state: 'started' }) })
  })

  it('reports a set it does not hold, or one whose source the caller cannot reach', async () => {
    const h = await harness()
    const unknown = brandString<LoomSetId>('loomset-unknown')
    expect(() => h.ctx.loom.setStatus({ setId: unknown })).toThrow(expect.objectContaining({ code: 'loom/set-not-found', details: { setId: unknown } }))
    expect(() => h.ctx.loom.cancel({ setId: unknown })).toThrow(expect.objectContaining({ code: 'loom/set-not-found' }))

    const root = await source(h)
    await run(root, 'first')
    const as = (method: string): Context => asGuest(h, method)
    const value = await as('branch').loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines: ['guest'] })
    const sessionId = started(value)[0]!
    await child(h, sessionId).whenIdle()
    const message = (await eventsOf(h, sessionId)).findLast(event => event.type === 'user/message') as SessionEvent<'user/message'>
    expect(message.data.source).toMatchObject({ kind: 'user', principal: GUEST })

    const bindings: RemoteAccessBinding[] = []
    h.ctx.remoteAccess.registerPolicy('loom-test-guest', { bindings: () => bindings })
    expect(() => as('setStatus').loom.setStatus({ setId: value.setId })).toThrow(expect.objectContaining({ code: 'loom/set-not-found' }))
    expect(() => as('cancel').loom.cancel({ setId: value.setId })).toThrow(expect.objectContaining({ code: 'loom/set-not-found' }))
    bindings.push({
      role: { name: 'loom-test:sets', resource: 'session', actions: ['loom/setStatus', 'loom/cancel'] },
      resource: { kind: 'session', id: root.id },
    })
    expect(as('setStatus').loom.setStatus({ setId: value.setId }).sourceSessionId).toBe(root.id)
    expect(as('cancel').loom.cancel({ setId: value.setId })).toEqual({ cancelled: [] })
  })

  it('runs writable children that share a folder one at a time', async () => {
    const h = await harness()
    const writable = await source(h)
    const other = await source(h, { folder: '/tmp/loom-other' })
    const readOnly = await source(h, { mode: 'read-only' })
    for (const agent of [writable, other, readOnly]) await run(agent, 'first')
    h.adapter.gated = true
    const steer = (agent: Agent, lines: string[]) => h.ctx.loom.branch({ sessionId: agent.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines })
    const blocked = await steer(writable, ['w1', 'w2'])
    expect(blocked.children.map(entry => entry.state)).toEqual(['started', 'queued'])
    // Another folder and a read-only set pass the blocked writable child.
    expect((await steer(other, ['o1'])).children.map(entry => entry.state)).toEqual(['started'])
    expect((await steer(readOnly, ['r1', 'r2'])).children.map(entry => entry.state)).toEqual(['started', 'started'])
    const first = started(blocked)[0]!
    await vi.waitFor(() => { expect(h.adapter.held()).toContain(first) })
    h.adapter.open(first)
    await vi.waitFor(() => { expect(h.ctx.loom.setStatus({ setId: blocked.setId }).children[1]).toMatchObject({ state: 'started' }) })
    h.adapter.release()
  })

  it('counts a cut without a sandbox mode by the deployment default, and lets writable children share a folder when configured', async () => {
    const h = await harness()
    h.ctx.provide('sandboxPolicy', { defaultMode: 'read-only' } as never)
    const root = await source(h)
    await run(root, 'first')
    h.adapter.gated = true
    const value = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines: ['a', 'b'] })
    expect(value.children.map(entry => entry.state)).toEqual(['started', 'started'])
    await vi.waitFor(() => { expect(h.adapter.held()).toHaveLength(2) })
    h.adapter.release()

    const shared = await harness({ concurrentWritableBranches: true })
    const writer = await source(shared)
    await run(writer, 'first')
    expect((await shared.ctx.loom.branch({ sessionId: writer.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines: ['a', 'b'] }))
      .children.map(entry => entry.state)).toEqual(['started', 'started'])
  })
})

describe('branch failures', () => {
  it('reports a failed fork and starts the other children', async () => {
    const h = await harness()
    const root = await source(h, { mode: 'read-only' })
    await run(root, 'first')
    const fork = h.ctx.sessionController.fork.bind(h.ctx.sessionController)
    vi.spyOn(h.ctx.sessionController, 'fork')
      .mockRejectedValueOnce(new RemoteError('session/fork-unavailable', 'no prefix', { sessionId: root.id }))
      .mockRejectedValueOnce(new Error('fork crashed'))
      .mockImplementation(fork)
    const value = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines: ['a', 'b', 'c'] })
    expect(value.children).toEqual([
      { index: 0, state: 'failed', code: 'session/fork-unavailable', message: 'no prefix' },
      { index: 1, state: 'failed', code: 'gateway/internal', message: 'fork crashed' },
      { index: 2, state: 'started', sessionId: ANY_SESSION },
    ])
    expect(h.ctx.loom.setStatus({ setId: value.setId }).children[1]).toEqual({ index: 1, state: 'failed', code: 'gateway/internal', message: 'fork crashed' })
    await child(h, started(value)[0]!).whenIdle()
  })

  it('reports the child Session when a step after the fork fails', async () => {
    const h = await harness()
    const root = await source(h)
    await run(root, 'first')
    h.workspaces.push({ id: 'workspace-1', path: FOLDER, sessionIds: [root.id], attachSession: async () => { throw new Error('workspace locked') } })
    const detached = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines: ['a'] })
    expect(detached.children).toEqual([{
      index: 0, state: 'failed', code: 'session/workspace-attach-failed', message: expect.stringContaining('workspace locked') as string, sessionId: ANY_SESSION,
    }])
    h.workspaces.length = 0

    vi.spyOn(h.ctx.sessionController, 'resolveAgent')
      .mockResolvedValueOnce({ error: new RemoteError('session/agent-busy', 'busy', { reason: 'test' }) })
    const busy = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines: ['b'] })
    expect(busy.children).toEqual([{ index: 0, state: 'failed', code: 'session/agent-busy', message: 'busy', sessionId: ANY_SESSION }])
    // Neither child received a record or a prompt.
    for (const value of [detached, busy]) {
      const entry = value.children[0]!
      const events = await eventsOf(h, (entry as { readonly sessionId: SessionId }).sessionId)
      expect(events.some(event => pluginRecordOf(event) !== undefined || (event.type === 'user/message' && textOf(event.data.content) !== 'first'))).toBe(false)
    }
  })

  it('keeps the slot of a prompted child whose flush failed until its Agent is idle', async () => {
    const h = await harness({ maxConcurrentBranches: 1 })
    const root = await source(h, { mode: 'read-only' })
    await run(root, 'first')
    h.adapter.gated = true
    vi.spyOn(h.ctx.sessions, 'flush').mockRejectedValueOnce('store offline')
    const value = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines: ['a', 'b'] })
    expect(value.children).toEqual([
      { index: 0, state: 'failed', code: 'gateway/internal', message: 'store offline', sessionId: ANY_SESSION },
      { index: 1, state: 'queued' },
    ])
    const first = (value.children[0] as { readonly sessionId: SessionId }).sessionId
    await vi.waitFor(() => { expect(h.adapter.held()).toEqual([first]) })
    h.adapter.open(first)
    await vi.waitFor(() => { expect(h.ctx.loom.setStatus({ setId: value.setId }).children[1]).toMatchObject({ state: 'started' }) })
    h.adapter.release()
  })
})

describe('Loom teardown', () => {
  it('waits for admissions in flight, withdraws queued children, and returns the set to the pending branch call', async () => {
    const { ctx, agents, loom: fiber } = await harness({ maxConcurrentBranches: 1 })
    const root = await agents.create(SessionId('loom-teardown'), { provider: 'mock', model: 'mock' }, { cwd: FOLDER })
    await run(root, 'first')
    const fork = ctx.sessionController.fork.bind(ctx.sessionController)
    const gate = Promise.withResolvers<undefined>()
    const spy = vi.spyOn(ctx.sessionController, 'fork').mockImplementation(async (request) => {
      await gate.promise
      return fork(request)
    })
    const pending = ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines: ['a', 'b'] })
    await vi.waitFor(() => { expect(spy).toHaveBeenCalledTimes(1) })
    const disposed = fiber.dispose()
    let settled = false
    void disposed.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    gate.resolve(undefined)
    await disposed
    // The admitted child runs on, so the caller learns its set; the queued child was withdrawn.
    const children = ctx.sessions.list().filter(session => session.header.parentSession === root.id)
    expect(children).toHaveLength(1)
    const value = await pending
    expect(value.setId).toMatch(/^loomset-/u)
    expect(value.children).toEqual([{ index: 0, state: 'started', sessionId: children[0]!.id }, { index: 1, state: 'cancelled' }])
    // The admitted child is complete: it holds its record and its prompt.
    const events = children[0]!.snapshotEvents()
    expect(events.some(event => pluginRecordOf(event)?.type === 'plugin:loom/branch')).toBe(true)
    expect(events.some(event => event.seq >= children[0]!.inheritedEventCount && event.type === 'user/message')).toBe(true)
    expect(ctx.get('loom')).toBeUndefined()
    expect(ctx.sessionProjections.stateOf(root.session, 'loomBranch')).toBeUndefined()
    expect(ctx.sessionProjections.stateOf(root.session, 'loomMark')).toBeUndefined()
  })

  it('rejects a branch call that teardown overtakes while it reads the source, and forks nothing', async () => {
    const { ctx, agents, loom: fiber } = await harness()
    const root = await agents.create(SessionId('loom-teardown-read'), { provider: 'mock', model: 'mock' }, { cwd: FOLDER })
    await run(root, 'first')
    const inspect = ctx.sessionController.inspect.bind(ctx.sessionController)
    const gate = Promise.withResolvers<undefined>()
    const read = vi.spyOn(ctx.sessionController, 'inspect').mockImplementation(async (sessionId) => {
      await gate.promise
      return inspect(sessionId)
    })
    const fork = vi.spyOn(ctx.sessionController, 'fork')
    const pending = ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines: ['a'] })
    await vi.waitFor(() => { expect(read).toHaveBeenCalledOnce() })
    await fiber.dispose()
    gate.resolve(undefined)
    await expect(pending).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(fork).not.toHaveBeenCalled()
  })
})

describe('loom.mark', () => {
  it('marks any Session privately, ignores marks a fork inherits, and never writes feedback', async () => {
    const h = await harness()
    const root = await source(h)
    await run(root, 'first')
    const records = (agent: Agent) => agent.session.snapshotEvents().filter(event => pluginRecordOf(event)?.type === 'plugin:loom/mark')
    const view = (agent: Agent) => h.ctx.sessionProjections.snapshot(agent.session).values.loomMark
    expect(view(root)).toBeNull()
    await expect(h.ctx.loom.mark({ sessionId: root.id, mark: 'keep' })).resolves.toEqual({ mark: 'keep' })
    expect(view(root)).toEqual({ mark: 'keep' })
    await h.ctx.loom.mark({ sessionId: root.id, mark: 'keep' })
    expect(records(root)).toHaveLength(1)
    await h.ctx.loom.mark({ sessionId: root.id, mark: 'set-aside' })
    expect(view(root)).toEqual({ mark: 'set-aside' })

    const value = await h.ctx.loom.branch({ sessionId: root.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines: ['a'] })
    const branch = child(h, started(value)[0]!)
    await branch.whenIdle()
    expect(records(branch)).toHaveLength(2)
    expect(view(branch)).toBeNull()
    await expect(h.ctx.loom.mark({ sessionId: branch.id, mark: null })).resolves.toEqual({ mark: null })
    expect(records(branch)).toHaveLength(2)
    await h.ctx.loom.mark({ sessionId: branch.id, mark: 'keep' })
    await h.ctx.loom.mark({ sessionId: branch.id, mark: null })
    expect(view(branch)).toBeNull()
    expect(records(branch)).toHaveLength(4)
    for (const agent of [root, branch]) expect(agent.session.snapshotEvents().some(event => event.type.startsWith('feedback/'))).toBe(false)

    await expect(h.ctx.loom.mark({ sessionId: SessionId('missing'), mark: 'keep' })).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('marks a cold Session by resuming it, flushes the record to disk, and reads it back after a reload', async () => {
    const store = await mkdtemp(join(tmpdir(), 'dsh-loom-mark-'))
    stores.push(store)
    const first = await harness({}, store)
    const sessionId = SessionId('loom-cold-mark')
    const created = await first.agents.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd: FOLDER })
    await run(created, 'first')
    // Disposing the Host releases the Agent, so the Session is cold in every later Host.
    await first.ctx.fiber.dispose()

    const stored = async (h: Harness): Promise<number> => {
      const handle = await h.ctx.sessionPersistence.open(sessionId, 'read')
      try {
        return (await handle.read()).events.filter(event => pluginRecordOf(event)?.type === 'plugin:loom/mark').length
      } finally {
        await handle.close()
      }
    }
    const second = await harness({}, store)
    expect(second.ctx.agents.get(sessionId)).toBeUndefined()
    await expect(second.ctx.loom.mark({ sessionId, mark: 'keep' })).resolves.toEqual({ mark: 'keep' })
    expect(second.ctx.agents.get(sessionId)).toBeDefined()
    expect(await stored(second)).toBe(1)
    // The same mark again writes no second record.
    await second.ctx.loom.mark({ sessionId, mark: 'keep' })
    expect(await stored(second)).toBe(1)
    await second.ctx.fiber.dispose()

    const third = await harness({}, store)
    const resolved = await third.ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw resolved.error
    expect(third.ctx.sessionProjections.snapshot(resolved.agent.session).values.loomMark).toEqual({ mark: 'keep' })
    await expect(third.ctx.loom.mark({ sessionId, mark: 'keep' })).resolves.toEqual({ mark: 'keep' })
    expect(await stored(third)).toBe(1)
  })
})

describe('finished branch set retention', () => {
  it('keeps active sets and evicts the oldest finished set together with its retry result', async () => {
    const h = await harness({ retainedBranchSets: 1, maxConcurrentBranches: 3, concurrentWritableBranches: true })
    const from = await source(h, { mode: 'read-only' })
    await run(from, 'hello')
    h.adapter.gated = true
    const firstRequest: LoomBranchRequest = { kind: 'regenerate', sessionId: from.id, requestId: requestId(), turn: 1, count: 1 }
    const secondRequest = { ...firstRequest, requestId: requestId() }
    const thirdRequest = { ...firstRequest, requestId: requestId() }
    const first = await h.ctx.loom.branch(firstRequest)
    const second = await h.ctx.loom.branch(secondRequest)
    const third = await h.ctx.loom.branch(thirdRequest)
    await vi.waitFor(() => { expect(h.adapter.held()).toHaveLength(3) })
    h.adapter.open(started(second)[0]!)
    await h.ctx.agents.get(started(second)[0]!)!.whenIdle()
    expect(h.ctx.loom.setStatus({ setId: first.setId }).setId).toBe(first.setId)
    h.adapter.open(started(third)[0]!)
    await h.ctx.agents.get(started(third)[0]!)!.whenIdle()
    expect(() => h.ctx.loom.setStatus({ setId: second.setId })).toThrow(expect.objectContaining({ code: 'loom/set-not-found' }))
    expect(await h.ctx.loom.branch(thirdRequest)).toEqual(third)
    h.adapter.release()
    await h.ctx.agents.get(started(first)[0]!)!.whenIdle()
    expect(() => h.ctx.loom.setStatus({ setId: first.setId })).toThrow(expect.objectContaining({ code: 'loom/set-not-found' }))
    const retried = await h.ctx.loom.branch(firstRequest)
    expect(retried.setId).not.toBe(first.setId)
    await h.ctx.agents.get(started(retried)[0]!)!.whenIdle()
  })

  it('counts failed admissions and cancelled queued sets as finished without evicting running sets', async () => {
    const h = await harness({ retainedBranchSets: 1, maxConcurrentBranches: 1 })
    const from = await source(h, { mode: 'read-only' })
    await run(from, 'hello')
    const request = (): LoomBranchRequest => ({ kind: 'regenerate', sessionId: from.id, requestId: requestId(), turn: 1, count: 1 })
    const fork = vi.spyOn(h.ctx.sessionController, 'fork').mockRejectedValueOnce(new Error('fork refused'))
    const failed = await h.ctx.loom.branch(request())
    expect(failed.children[0]?.state).toBe('failed')
    fork.mockRestore()
    h.adapter.gated = true
    const active = await h.ctx.loom.branch(request())
    const queued = await h.ctx.loom.branch(request())
    expect(h.ctx.loom.cancel({ setId: queued.setId })).toEqual({ cancelled: [0] })
    expect(() => h.ctx.loom.setStatus({ setId: failed.setId })).toThrow(expect.objectContaining({ code: 'loom/set-not-found' }))
    expect(h.ctx.loom.setStatus({ setId: active.setId }).setId).toBe(active.setId)
    h.adapter.release()
    await h.ctx.agents.get(started(active)[0]!)!.whenIdle()
  })
})
