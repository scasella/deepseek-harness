/**
 * The five autoloom tools over the real Loom service, Session Controller
 * fork, agent loop, and token meter: the `loom` prompt source and the child
 * preset before each child's prompt, budgets checked before any fork, the
 * own-token watcher, waits, reads, culls, keeps, refusals, and unloading.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LoomSetId } from '@deepseek-ai/dsh-experimental-loom'
import { pluginRecordOf, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/index.ts'
import { BUDGET_STOP_REASON, CULL_STOP_REASON, USD_STOP_REASON, UNLOADED_STOP_REASON } from '../src/runtime.ts'
import type { CullValue, ExpandValue, KeepValue, ReadValue, WaitValue } from '../src/schemas.ts'
import {
  call,
  lastUserText,
  mountAutoloomHost,
  run,
  textOf,
  textReply,
  toolReply,
  valueOf,
  type AutoloomHost,
} from './autoloom-host.ts'
import type { Config as LoomConfig } from '@deepseek-ai/dsh-experimental-loom'

const roots: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
})

const FOLDER = '/tmp/autoloom'
const STORY_PROMPT = 'Write the first line of a story.'

async function harness(config: Config = {}, loomConfig: LoomConfig = {}): Promise<AutoloomHost> {
  const ctx = new Context()
  roots.push(ctx)
  return mountAutoloomHost(ctx, config, { concurrentWritableBranches: true, defaultIsolation: 'shared', ...loomConfig })
}

let sessionCount = 0
async function session(h: AutoloomHost, name: string, cwd: string | null = FOLDER): Promise<Agent> {
  sessionCount += 1
  return h.agents.create(SessionId(`${name}-${String(sessionCount)}`), { provider: 'mock', model: 'mock' }, cwd === null ? {} : { cwd })
}

/** A story Session with one completed turn. */
async function story(h: AutoloomHost, cwd: string | null = FOLDER): Promise<Agent> {
  const agent = await session(h, 'story', cwd)
  await run(agent, STORY_PROMPT)
  return agent
}

function live(h: AutoloomHost, sessionId: string): Agent {
  const agent = h.ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) throw new Error(`${sessionId} is not live`)
  return agent
}

async function ownEvents(h: AutoloomHost, sessionId: string): Promise<readonly SessionEvent[]> {
  const inspection = await h.ctx.sessionController.inspect(SessionId(sessionId))
  return inspection.events.slice(inspection.inheritedEventCount)
}

function startedIds(value: ExpandValue): string[] {
  return value.children.flatMap(child => child.sessionId === undefined ? [] : [child.sessionId])
}

async function expand(h: AutoloomHost, weaver: Agent, args: object, callId?: string): Promise<ExpandValue> {
  return (valueOf(await call(h, weaver, 'loom_expand', args, callId === undefined ? {} : { callId })) as ExpandValue)
}

async function waitFor(h: AutoloomHost, weaver: Agent, setId: string, timeoutMs?: number): Promise<WaitValue> {
  return (valueOf(await call(h, weaver, 'loom_wait', { setId, ...timeoutMs === undefined ? {} : { timeoutMs } })) as WaitValue)
}

async function refusal(h: AutoloomHost, weaver: Agent | undefined, name: string, args: object): Promise<string> {
  const result = await call(h, weaver, name, args)
  expect(result.isError).toBe(true)
  return textOf(result).replace(/^Error: /u, '')
}

describe('loom_expand', () => {
  it('refuses unpriced routes and unaffordable list-price expansions before any fork', async () => {
    const h = await harness({ autoloom: { maxUsd: 0.000001 } })
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const fork = vi.spyOn(h.ctx.sessionController, 'fork')
    expect(await refusal(h, weaver, 'loom_expand', { sessionId: subject.id, afterTurn: 1, lines: ['a'] })).toContain('requires configured prices')
    expect(fork).not.toHaveBeenCalled()
    const priced = await harness({ autoloom: { maxUsd: 0.000001 } }, { pricing: [{ provider: 'mock', model: 'mock', inputMissPerMTok: 1, inputHitPerMTok: 1, outputPerMTok: 1 }] })
    const pricedSubject = await story(priced)
    const pricedWeaver = await session(priced, 'weaver')
    const pricedFork = vi.spyOn(priced.ctx.sessionController, 'fork')
    expect(await refusal(priced, pricedWeaver, 'loom_expand', { sessionId: pricedSubject.id, afterTurn: 1, lines: ['a'] })).toContain('cannot cover this expansion')
    expect(pricedFork).not.toHaveBeenCalled()
  })

  it('reports remaining list-price dollars after a priced expansion', async () => {
    const h = await harness({ autoloom: { maxUsd: 1 } }, { pricing: [{ provider: 'mock', model: 'mock', inputMissPerMTok: 1, inputHitPerMTok: 1, outputPerMTok: 1 }] })
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['a'] })
    await live(h, startedIds(value)[0]!).whenIdle()
    const waited = await waitFor(h, weaver, value.setId)
    expect(waited.budget.usdLeft).toBeCloseTo(1 - 15 / 1_000_000)
  })

  it('prices a self-targeted resample and preserves dollars when a child is no longer live', async () => {
    const h = await harness({ autoloom: { maxUsd: 1 } }, { pricing: [{ provider: 'mock', model: 'mock', inputMissPerMTok: 1, inputHitPerMTok: 1, outputPerMTok: 1 }] })
    const weaver = await story(h)
    await run(weaver, 'Continue the story.')
    const value = await expand(h, weaver, { afterTurn: 1, count: 1 })
    const child = live(h, startedIds(value)[0]!)
    await child.whenIdle()
    const get = h.ctx.agents.get.bind(h.ctx.agents)
    vi.spyOn(h.ctx.agents, 'get').mockImplementation(id => id === child.id ? undefined : get(id))
    expect((await waitFor(h, weaver, value.setId)).budget.usdLeft).toBeCloseTo(1 - 15 / 1_000_000)
  })

  it('refuses further spending when a child route loses its configured price', async () => {
    const h = await harness({ autoloom: { maxUsd: 1 } }, { pricing: [{ provider: 'mock', model: 'mock', inputMissPerMTok: 1, inputHitPerMTok: 1, outputPerMTok: 1 }] })
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['a'] })
    await live(h, startedIds(value)[0]!).whenIdle()
    vi.spyOn(h.ctx.loom, 'ownUsd').mockReturnValue(undefined)
    expect((await waitFor(h, weaver, value.setId)).budget.usdLeft).toBe(0)
    const fork = vi.spyOn(h.ctx.sessionController, 'fork')
    expect(await refusal(h, weaver, 'loom_expand', { sessionId: subject.id, afterTurn: 1, lines: ['b'] })).toContain('requires configured prices')
    expect(fork).not.toHaveBeenCalled()
  })

  it('starts one child per line, each holding its branch record and the child preset before its loom-sourced prompt', async () => {
    const h = await harness()
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const lines = ['Continue darkly.', 'Continue brightly.']
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines }, 'expand-lines')
    expect(value.children.map(child => child.state)).toEqual(['started', 'started'])
    expect(value.budget).toMatchObject({ branchesLeft: 6, maxDepth: 2 })
    for (const [index, childId] of startedIds(value).entries()) {
      const child = live(h, childId)
      await child.whenIdle()
      expect(child.session.header.parentSession).toBe(subject.id)
      const own = await ownEvents(h, childId)
      const recordAt = own.findIndex(event => pluginRecordOf(event)?.type === 'plugin:loom/branch')
      const presetAt = own.findIndex(event => event.type === 'permission/preset')
      const promptAt = own.findIndex(event => event.type === 'user/message')
      expect([recordAt < presetAt, presetAt < promptAt]).toEqual([true, true])
      expect(own[presetAt]!.data).toEqual({ preset: 'auto' })
      const prompt = own[promptAt] as SessionEvent<'user/message'>
      expect(prompt.data.source).toEqual({ kind: 'loom', weaver: weaver.id, callId: 'expand-lines' })
      expect(prompt.data.content).toEqual([{ type: 'text', text: lines[index] }])
    }
    const waited = await waitFor(h, weaver, value.setId)
    expect(waited).toEqual({
      setId: value.setId,
      timedOut: false,
      children: startedIds(value).map((sessionId, index) => ({ index, state: 'idle', sessionId, ownTokens: 15 })),
      budget: { branchesLeft: 6, ownTokensLeft: 2_000_000 - 30, maxDepth: 2 },
    })
  })

  it('resamples the next turn count times with its opening prompt', async () => {
    const h = await harness({ autoloom: { childPermissionPreset: 'loom-child' } })
    const subject = await story(h)
    await run(subject, 'Continue the story.')
    const weaver = await session(h, 'weaver')
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, count: 2 }, 'expand-count')
    expect(value.children).toHaveLength(2)
    for (const childId of startedIds(value)) {
      await live(h, childId).whenIdle()
      const own = await ownEvents(h, childId)
      const prompt = own.find((event): event is SessionEvent<'user/message'> => event.type === 'user/message')!
      expect(prompt.data.content).toEqual([{ type: 'text', text: 'Continue the story.' }])
      expect(prompt.data.source).toMatchObject({ kind: 'loom', callId: 'expand-count' })
      expect(own.find(event => event.type === 'permission/preset')?.data).toEqual({ preset: 'loom-child' })
    }
  })

  it('returns the first set for a repeated call and counts its children once', async () => {
    const h = await harness()
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const fork = vi.spyOn(h.ctx.sessionController, 'fork')
    const args = { sessionId: subject.id, afterTurn: 1, lines: ['a', 'b'] }
    const [first, second] = await Promise.all([expand(h, weaver, args, 'same-call'), expand(h, weaver, args, 'same-call')])
    expect(second.setId).toBe(first.setId)
    expect(second.budget.branchesLeft).toBe(6)
    const third = await expand(h, weaver, args, 'same-call')
    expect(third.setId).toBe(first.setId)
    expect(third.budget.branchesLeft).toBe(6)
    expect(fork).toHaveBeenCalledTimes(2)
  })

  it('refuses before any fork past the branch budget and releases the count of a rejected request', async () => {
    const h = await harness({ autoloom: { maxBranches: 2 } })
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const fork = vi.spyOn(h.ctx.sessionController, 'fork')
    expect(await refusal(h, weaver, 'loom_expand', { sessionId: subject.id, afterTurn: 1, lines: ['a', 'b', 'c'] }))
      .toBe('This Session may start 2 more branches, not 3; no branch was created.')
    expect(await refusal(h, weaver, 'loom_expand', { sessionId: subject.id, afterTurn: 7, lines: ['a'] })).toContain('cannot branch at turn 7: not-found')
    expect(fork).not.toHaveBeenCalled()
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['a', 'b'] })
    expect(value.budget.branchesLeft).toBe(0)
    expect(await refusal(h, weaver, 'loom_expand', { sessionId: subject.id, afterTurn: 1, count: 1 }))
      .toBe('This Session may start 0 more branches, not 1; no branch was created.')
    expect(fork).toHaveBeenCalledTimes(2)
  })

  it('counts generations through the fork lineage, including a person\'s fork of a child', async () => {
    const h = await harness({ autoloom: { maxDepth: 1 } })
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const [childId] = startedIds(await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['first generation'] }))
    await live(h, childId!).whenIdle()
    const { sessionId: personForkId } = await h.ctx.sessionController.fork({ sessionId: SessionId(childId!) })
    const fork = vi.spyOn(h.ctx.sessionController, 'fork')
    for (const sessionId of [childId, personForkId]) {
      expect(await refusal(h, weaver, 'loom_expand', { sessionId, afterTurn: 2, lines: ['second generation'] }))
        .toBe('These branches would be generation 2 of this Session\'s branches; the limit is 1. No branch was created.')
    }
    expect(fork).not.toHaveBeenCalled()
    // Loom resamples only turns a person opened; the refusal releases the reservation.
    expect(await refusal(h, (await session(h, 'deep-weaver')), 'loom_expand', { sessionId: childId, afterTurn: 1, count: 1 }))
      .toContain('cannot branch at turn 2: not-user-opened')
  })

  it('allows a deeper generation up to maxDepth', async () => {
    const h = await harness()
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const [childId] = startedIds(await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['one'] }))
    await live(h, childId!).whenIdle()
    const [grandchildId] = startedIds(await expand(h, weaver, { sessionId: childId, afterTurn: 2, lines: ['two'] }))
    expect(live(h, grandchildId!).session.header.parentSession).toBe(childId)
    await live(h, grandchildId!).whenIdle()
    expect(await refusal(h, weaver, 'loom_expand', { sessionId: grandchildId, afterTurn: 3, lines: ['three'] })).toContain('generation 3')
  })

  it('refuses once the own-token budget is used up, after stopping only the child still running', async () => {
    const h = await harness({ autoloom: { maxOwnTokens: 29 } }, { maxConcurrentBranches: 1 })
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['a', 'b'] })
    const waited = await waitFor(h, weaver, value.setId)
    expect(waited.budget.ownTokensLeft).toBe(0)
    expect(waited.children.map(child => child.stoppedByBudget)).toEqual([undefined, true])
    expect(await refusal(h, weaver, 'loom_expand', { sessionId: subject.id, afterTurn: 1, lines: ['c'] }))
      .toBe('The own-token budget of 29 tokens for this Session\'s branches is used up; no branch was created.')
  })

  it('refuses a target outside the weaver\'s working directory, and lets a weaver without one branch itself', async () => {
    const h = await harness()
    const elsewhere = await story(h, '/tmp/elsewhere')
    const weaver = await session(h, 'weaver')
    expect(await refusal(h, weaver, 'loom_expand', { sessionId: elsewhere.id, afterTurn: 1, lines: ['a'] }))
      .toBe(`Session "${elsewhere.id}" is not in this Session's working directory; no branch was created.`)
    const homeless = await story(h, null)
    expect(await refusal(h, homeless, 'loom_expand', { sessionId: elsewhere.id, afterTurn: 1, lines: ['a'] })).toContain('not in this Session\'s working directory')
    const value = await expand(h, homeless, { afterTurn: 1, lines: ['continue yourself'] })
    expect(live(h, startedIds(value)[0]!).session.header.parentSession).toBe(homeless.id)
    expect(value.children[0]).toMatchObject({ state: 'started' })
    expect(await refusal(h, weaver, 'loom_expand', { sessionId: 'no-such-session', afterTurn: 1, lines: ['a'] })).toContain('not found')
  })

  it('refuses malformed arguments before any fork', async () => {
    const h = await harness()
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const fork = vi.spyOn(h.ctx.sessionController, 'fork')
    expect(await refusal(h, weaver, 'loom_expand', { sessionId: subject.id, afterTurn: 1, lines: ['a'], count: 1 })).toBe('Give exactly one of lines and count.')
    expect(await refusal(h, weaver, 'loom_expand', { sessionId: subject.id, afterTurn: 1 })).toBe('Give exactly one of lines and count.')
    expect(await refusal(h, weaver, 'loom_expand', { sessionId: subject.id, afterTurn: -1, count: 1 })).toBe('afterTurn must not be negative.')
    expect(await refusal(h, weaver, 'loom_expand', { sessionId: subject.id, afterTurn: 1, count: 0 })).toBe('Ask for at least one branch.')
    expect(await refusal(h, weaver, 'loom_expand', { sessionId: subject.id, afterTurn: 1, lines: [] })).toBe('Ask for at least one branch.')
    expect(await refusal(h, undefined, 'loom_expand', { sessionId: subject.id, afterTurn: 1, count: 1 })).toContain('loom_expand requires a calling Session')
    expect(fork).not.toHaveBeenCalled()
  })

  it('refuses when the child preset is missing or interactive at the call', async () => {
    const h = await harness()
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const args = { sessionId: subject.id, afterTurn: 1, lines: ['a'] }
    h.presets.specs.auto = { sandbox: 'read-only', approval: 'ask' }
    expect(await refusal(h, weaver, 'loom_expand', args)).toBe('Branches cannot start: their permission preset "auto" is interactive on this Host.')
    delete h.presets.specs.auto
    expect(await refusal(h, weaver, 'loom_expand', args)).toBe('Branches cannot start: their permission preset "auto" is not available on this Host.')
  })

  it('reports children that failed, counting only those that got a Session', async () => {
    const h = await harness()
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const realFork = h.ctx.sessionController.fork.bind(h.ctx.sessionController)
    vi.spyOn(h.ctx.sessionController, 'fork')
      .mockRejectedValueOnce(new RemoteError('session/model-unavailable', 'no route', { provider: 'mock', model: 'mock' }))
      .mockImplementation(realFork)
    const set = vi.spyOn(h.presets, 'set').mockImplementationOnce(() => { throw new Error('preset store offline') })
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['a', 'b'] })
    expect(set).toHaveBeenCalledOnce()
    expect(value.children[0]).toEqual({ index: 0, state: 'failed', error: 'session/model-unavailable: no route' })
    expect(value.children[1]).toEqual({ index: 1, state: 'failed', sessionId: expect.any(String) as string, error: 'gateway/internal: preset store offline' })
    expect(value.budget.branchesLeft).toBe(7)
    const failedId = value.children[1]!.sessionId!
    expect((valueOf(await call(h, weaver, 'loom_read', { sessionId: failedId })) as ReadValue)).toMatchObject({ output: '', state: 'idle', ownTokens: 0 })
    expect((await waitFor(h, weaver, value.setId)).children).toEqual([
      { index: 0, state: 'failed', error: 'session/model-unavailable: no route' },
      { index: 1, state: 'failed', sessionId: failedId, error: 'gateway/internal: preset store offline', ownTokens: 0 },
    ])
  })
})

describe('a weaver model', () => {
  it('expands, waits, reads, keeps, and culls through the agent loop', async () => {
    const h = await harness({ autoloom: { maxBranches: 3 } })
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const lastTool = (options: Parameters<typeof h.adapter.respond>[0]): string => (options.messages.findLast(message => message.role === 'tool')?.content ?? [])
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    let step = 0
    let ids: string[] = []
    h.adapter.respond = (options) => {
      if (options.sessionId !== weaver.id) return textReply(`line after: ${lastUserText(options)}`)
      step += 1
      if (step === 1) return toolReply('weave-1', 'loom_expand', { sessionId: subject.id, afterTurn: 1, lines: ['darker', 'brighter'] })
      if (step === 2) {
        const expanded = JSON.parse(lastTool(options)) as ExpandValue
        ids = startedIds(expanded)
        return toolReply('weave-2', 'loom_wait', { setId: expanded.setId })
      }
      if (step === 3) return toolReply('weave-3', 'loom_read', { sessionId: ids[0] })
      if (step === 4) return toolReply('weave-4', 'loom_keep', { sessionId: ids[0] })
      if (step === 5) return toolReply('weave-5', 'loom_cull', { sessionId: ids[1] })
      return textReply(`kept ${ids[0]!}`)
    }
    await run(weaver, `Explore two continuations of Session ${subject.id} and keep the better one.`)
    expect(step).toBe(6)
    const read = h.adapter.requests.filter(request => request.sessionId === weaver.id)[3]!
    expect(JSON.parse(lastTool(read))).toMatchObject({ sessionId: ids[0], output: 'line after: darker', state: 'idle' })
    for (const [index, childId] of ids.entries()) {
      const own = await ownEvents(h, childId)
      expect(own.find((event): event is SessionEvent<'user/message'> => event.type === 'user/message')?.data.source)
        .toEqual({ kind: 'loom', weaver: weaver.id, callId: 'weave-1' })
      expect(live(h, childId).session.header.parentSession).toBe(subject.id)
      expect(h.ctx.sessionProjections.stateOf(live(h, childId).session, 'loomMark')?.mark).toEqual(index === 0 ? { mark: 'keep' } : null)
    }
    expect(h.archived).toEqual([ids[1]])
  })
})

describe('autoloom children', () => {
  it('refuse every autoloom tool, while a Session opened by a person may weave', async () => {
    const h = await harness()
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['a'] })
    const [childId] = startedIds(value)
    const child = live(h, childId!)
    await child.whenIdle()
    const refused = 'This Session is a branch that a weaver started; only the weaver may use the loom tools.'
    expect(await refusal(h, child, 'loom_expand', { sessionId: subject.id, afterTurn: 1, lines: ['b'] })).toBe(refused)
    expect(await refusal(h, child, 'loom_wait', { setId: value.setId })).toBe(refused)
    expect(await refusal(h, child, 'loom_read', { sessionId: childId })).toBe(refused)
    expect(await refusal(h, child, 'loom_cull', { sessionId: childId })).toBe(refused)
    expect(await refusal(h, child, 'loom_keep', { sessionId: childId })).toBe(refused)
    // The story's first own prompt came from a person: it weaves, and the answer is cached.
    const inspect = vi.spyOn(h.ctx.sessionController, 'inspect')
    const reads = (): number => inspect.mock.calls.filter(([id]) => id === subject.id).length
    expect((await expand(h, subject, { sessionId: subject.id, afterTurn: 1, lines: ['b'] })).children[0]).toMatchObject({ state: 'started' })
    const first = reads()
    await expand(h, subject, { sessionId: subject.id, afterTurn: 1, lines: ['c'] })
    expect(reads() - first).toBeLessThan(first)
  })

  it('stops a priced child and withdraws queued children after the dollar budget is crossed', async () => {
    const h = await harness({ autoloom: { maxUsd: 0.0001 } }, {
      maxConcurrentBranches: 1,
      pricing: [{ provider: 'mock', model: 'mock', inputMissPerMTok: 1, inputHitPerMTok: 1, outputPerMTok: 1 }],
    })
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    h.adapter.respond = () => toolReply('spend-dollars', 'loom_keep', { sessionId: 'nothing' }, { inputTokens: 200, outputTokens: 5 })
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['spend', 'queued'] })
    const child = live(h, startedIds(value)[0]!)
    const waited = await waitFor(h, weaver, value.setId)
    expect(waited.children[0]).toMatchObject({ stoppedByBudget: true, state: 'idle' })
    expect(waited.children[1]).toMatchObject({ state: 'cancelled' })
    expect(waited.budget.usdLeft).toBe(0)
    expect(child.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data)
      .toMatchObject({ reason: { kind: 'aborted', reason: { kind: 'hook', reason: USD_STOP_REASON } } })
  })

  it('are stopped and their queued siblings withdrawn when their own tokens pass the budget', async () => {
    const h = await harness({ autoloom: { maxOwnTokens: 20 } }, { maxConcurrentBranches: 1 })
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    h.adapter.respond = options => options.sessionId === subject.id
      ? textReply('story')
      : toolReply(`spend-${String(options.sessionId)}`, 'loom_keep', { sessionId: 'nothing' }, { inputTokens: 30, outputTokens: 5 })
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['spend', 'never runs'] })
    expect(value.children.map(child => child.state)).toEqual(['started', 'queued'])
    const waited = await waitFor(h, weaver, value.setId)
    const [childId] = startedIds(value)
    expect(waited.children).toEqual([
      { index: 0, state: 'idle', sessionId: childId, ownTokens: 35, stoppedByBudget: true },
      { index: 1, state: 'cancelled' },
    ])
    expect(waited.budget.ownTokensLeft).toBe(0)
    const ends = (await ownEvents(h, childId!)).filter((event): event is SessionEvent<'turn/end'> => event.type === 'turn/end')
    expect(ends.map(event => event.data.reason)).toEqual([{ kind: 'aborted', reason: { kind: 'hook', reason: BUDGET_STOP_REASON } }])
    expect((valueOf(await call(h, weaver, 'loom_read', { sessionId: childId })) as ReadValue)).toMatchObject({ stoppedByBudget: true, ownTokens: 35 })
  })

  it('admitted after the budget ran out fail without a prompt', async () => {
    const h = await harness({ autoloom: { maxOwnTokens: 20 } }, { maxConcurrentBranches: 1 })
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    h.adapter.respond = options => options.sessionId === subject.id
      ? textReply('story')
      : textReply('spent', { inputTokens: 30, outputTokens: 5 })
    // A withdrawal that misses the queued child: it is admitted once the first child is idle.
    const cancel = vi.spyOn(h.ctx.loom, 'cancel').mockReturnValue({ cancelled: [] })
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['spend', 'late'] })
    const waited = await waitFor(h, weaver, value.setId)
    expect(cancel).toHaveBeenCalledWith({ setId: value.setId })
    expect(waited.children[1]).toMatchObject({ index: 1, state: 'failed', error: 'autoloom/child-refused: The own-token budget of these branches is used up; this branch got no prompt.' })
    const own = await ownEvents(h, waited.children[1]!.sessionId!)
    expect(own.filter(event => event.type === 'user/message')).toEqual([])
  })

  it('stops running children and withdraws queued children when the tools unload', async () => {
    const h = await harness({}, { maxConcurrentBranches: 1 })
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    h.adapter.respond = options => options.sessionId === subject.id ? textReply('story') : 'hang'
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['hang', 'queued'] })
    const first = live(h, startedIds(value)[0]!)
    await vi.waitFor(() => { expect(first.status).toBe('running') })
    await h.tools.dispose()
    expect(first.status).toBe('idle')
    const setId = brandString<LoomSetId>(value.setId)
    expect(h.ctx.loom.setStatus({ setId }).children[1]).toMatchObject({ state: 'cancelled' })
    expect((await ownEvents(h, first.id)).findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'hook', reason: UNLOADED_STOP_REASON } } } })
  })

  it('report a withdrawal failure without failing the Session commit', async () => {
    const h = await harness({ autoloom: { maxOwnTokens: 20 } })
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    h.adapter.respond = options => options.sessionId === subject.id ? textReply('story') : textReply('spent', { inputTokens: 30, outputTokens: 5 })
    const warn = vi.spyOn(h.ctx.logger, 'warn')
    const cancel = vi.spyOn(h.ctx.loom, 'cancel')
      .mockImplementationOnce(({ setId }) => { throw new RemoteError('loom/set-not-found', 'evicted', { setId }) })
      .mockImplementationOnce(() => { throw new Error('loom offline') })
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['spend'] })
    await waitFor(h, weaver, value.setId)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual(['tool-loom: branches crossed the own-token budget of 20; stopping them'])
    // A person prompts the child again; its next usage finds the run already over budget.
    await run(live(h, startedIds(value)[0]!), 'again')
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.map(([message]) => String(message)).at(-1))
      .toBe(`tool-loom: queued children of branch set "${value.setId}" were not withdrawn: Error: loom offline`)
  })
})

describe('loom_wait', () => {
  it('times out on running children, rejects bad timeouts, and follows cancellation', async () => {
    const h = await harness({ defaultWaitMs: 40 }, { maxConcurrentBranches: 1 })
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    h.adapter.respond = () => 'hang'
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['hang', 'queued behind it'] })
    const [childId] = startedIds(value)
    expect(await waitFor(h, weaver, value.setId)).toEqual({
      setId: value.setId,
      timedOut: true,
      children: [{ index: 0, state: 'running', sessionId: childId, ownTokens: 0 }, { index: 1, state: 'queued' }],
      budget: { branchesLeft: 6, ownTokensLeft: 2_000_000, maxDepth: 2 },
    })
    expect(await refusal(h, weaver, 'loom_wait', { setId: value.setId, timeoutMs: 0 })).toBe('timeoutMs must be an integer from 1 through 1800000.')
    expect(await refusal(h, weaver, 'loom_wait', { setId: value.setId, timeoutMs: 1_800_001 })).toBe('timeoutMs must be an integer from 1 through 1800000.')
    expect(await refusal(h, weaver, 'loom_wait', { setId: 'loomset-unknown' })).toBe('"loomset-unknown" is not a branch set this Session started.')
    const later = new AbortController()
    const pending = call(h, weaver, 'loom_wait', { setId: value.setId, timeoutMs: 60_000 }, { signal: later.signal })
    // Let the wait reach its listener before cancelling it.
    await new Promise(resolve => setTimeout(resolve, 30))
    later.abort(new Error('wait cancelled'))
    expect(textOf(await pending)).toContain('wait cancelled')
    const plain = new AbortController()
    const plainPending = call(h, weaver, 'loom_wait', { setId: value.setId, timeoutMs: 60_000 }, { signal: plain.signal })
    await new Promise(resolve => setTimeout(resolve, 30))
    plain.abort('stop waiting')
    expect((await plainPending).isError).toBe(true)
    const culled = (valueOf(await call(h, weaver, 'loom_cull', { sessionId: childId })) as CullValue)
    expect(culled).toEqual({ sessionId: childId, stopped: true, archived: true })
  })

  it('wakes when a queued child starts and finishes', async () => {
    const h = await harness({}, { maxConcurrentBranches: 1 })
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['one', 'two'] })
    expect(value.children[1]).toEqual({ index: 1, state: 'queued' })
    const waited = await waitFor(h, weaver, value.setId)
    expect(waited.children.map(child => [child.state, child.ownTokens])).toEqual([['idle', 15], ['idle', 15]])
    const secondId = waited.children[1]!.sessionId!
    expect(lastUserText(h.adapter.requests.find(request => request.sessionId === secondId)!)).toBe('two')
  })

  it('fails when the Loom service no longer holds the set, and passes other failures through', async () => {
    const h = await harness()
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['a'] })
    const [childId] = startedIds(value)
    await live(h, childId!).whenIdle()
    const status = vi.spyOn(h.ctx.loom, 'setStatus').mockImplementation(({ setId }) => {
      throw new RemoteError('loom/set-not-found', 'evicted', { setId })
    })
    expect(await refusal(h, weaver, 'loom_wait', { setId: value.setId })).toBe(`Branch set "${value.setId}" is no longer held by this Host.`)
    // A child the run already counts stays readable.
    expect((valueOf(await call(h, weaver, 'loom_read', { sessionId: childId })) as ReadValue).output).toBe('reply: a')
    status.mockImplementation(() => { throw new Error('loom offline') })
    expect(await refusal(h, weaver, 'loom_wait', { setId: value.setId })).toContain('loom offline')
  })

  it('ends with an unloaded refusal when the tools unload during the wait', async () => {
    const h = await harness()
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    h.adapter.respond = options => options.sessionId === subject.id ? textReply('story') : 'hang'
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['hang'] })
    const pending = call(h, weaver, 'loom_wait', { setId: value.setId, timeoutMs: 60_000 })
    await vi.waitFor(() => { expect(live(h, startedIds(value)[0]!).status).toBe('running') })
    await h.tools.dispose()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('Error: The loom tools were unloaded; no branch was changed.')
  })
})

describe('loom_read, loom_keep, and loom_cull', () => {
  it('read bounded output, keep a child, and archive an idle child without stopping it', async () => {
    const h = await harness({ defaultReadChars: 5, maxReadChars: 10 })
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['the better line', 'the worse line'] })
    const [keptId, culledId] = startedIds(value)
    await waitFor(h, weaver, value.setId)
    expect((valueOf(await call(h, weaver, 'loom_read', { sessionId: keptId })) as ReadValue)).toEqual({
      sessionId: keptId, state: 'idle', output: 'reply', truncated: true, chars: 'reply: the better line'.length, ownTokens: 15,
    })
    expect((valueOf(await call(h, weaver, 'loom_read', { sessionId: keptId, maxChars: 10 })) as ReadValue).output).toBe('reply: the')
    expect(await refusal(h, weaver, 'loom_read', { sessionId: keptId, maxChars: 11 })).toBe('maxChars must be an integer from 1 through 10.')
    expect((valueOf(await call(h, weaver, 'loom_keep', { sessionId: keptId })) as KeepValue)).toEqual({ sessionId: keptId, mark: 'keep' })
    expect(h.ctx.sessionProjections.stateOf(live(h, keptId!).session, 'loomMark')?.mark).toEqual({ mark: 'keep' })
    expect((valueOf(await call(h, weaver, 'loom_cull', { sessionId: culledId })) as CullValue)).toEqual({ sessionId: culledId, stopped: false, archived: true })
    expect(h.archived).toEqual([culledId])
    expect(h.archiveSession).toHaveBeenCalledWith(culledId, { stopActivity: true })
    expect((valueOf(await call(h, weaver, 'loom_read', { sessionId: culledId, maxChars: 10 })) as ReadValue)).toMatchObject({ archived: true, truncated: true })
  })

  it('stop a running child with the cull cause before archiving it', async () => {
    const h = await harness()
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    h.adapter.respond = options => options.sessionId === subject.id ? textReply('story') : 'hang'
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['hang'] })
    const [childId] = startedIds(value)
    const child = live(h, childId!)
    await vi.waitFor(() => { expect(child.status).toBe('running') })
    expect((valueOf(await call(h, weaver, 'loom_read', { sessionId: childId })) as ReadValue)).toMatchObject({ state: 'running', output: '' })
    expect((valueOf(await call(h, weaver, 'loom_cull', { sessionId: childId })) as CullValue)).toMatchObject({ stopped: true })
    await child.whenIdle()
    const ends = (await ownEvents(h, childId!)).filter((event): event is SessionEvent<'turn/end'> => event.type === 'turn/end')
    expect(ends.map(event => event.data.reason)).toEqual([{ kind: 'aborted', reason: { kind: 'hook', reason: CULL_STOP_REASON } }])
  })

  it('refuse Sessions the weaver did not start', async () => {
    const h = await harness()
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const other = await session(h, 'other-weaver')
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['a'] })
    const [childId] = startedIds(value)
    for (const name of ['loom_read', 'loom_cull', 'loom_keep']) {
      expect(await refusal(h, other, name, { sessionId: childId })).toBe(`"${childId}" is not a branch this Session started.`)
      expect(await refusal(h, weaver, name, { sessionId: subject.id })).toBe(`"${subject.id}" is not a branch this Session started.`)
    }
    expect(await refusal(h, other, 'loom_wait', { setId: value.setId })).toBe(`"${value.setId}" is not a branch set this Session started.`)
  })
})

describe('the tool plugin', () => {
  it('drains an expansion already creating its child and gives that child no prompt after unload', async () => {
    const h = await harness()
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const fork = h.ctx.sessionController.fork.bind(h.ctx.sessionController)
    vi.spyOn(h.ctx.sessionController, 'fork').mockImplementationOnce(async (request) => {
      entered.resolve(undefined)
      await release.promise
      return fork(request)
    })
    const expanding = expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['late child'] })
    await entered.promise
    let disposed = false
    const teardown = h.tools.dispose().then(() => { disposed = true })
    await Promise.resolve(undefined)
    expect(disposed).toBe(false)
    release.resolve(undefined)
    const value = await expanding
    await teardown
    const child = value.children[0]!
    expect(child.state).toBe('failed')
    expect(child.error).toContain('tools were unloaded')
    expect((await ownEvents(h, child.sessionId!)).filter(event => event.type === 'user/message')).toEqual([])
  })

  it('contains cancellation and withdrawal reports while still draining stopped children', async () => {
    const h = await harness()
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    h.adapter.respond = () => 'hang'
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['running'] })
    const child = live(h, startedIds(value)[0]!)
    const cancel = child.cancel.bind(child)
    vi.spyOn(child, 'cancel').mockImplementationOnce((...args) => {
      cancel(...args)
      throw new Error('A cancellation observer failed')
    })
    vi.spyOn(h.ctx.loom, 'cancel')
      .mockImplementationOnce(({ setId }) => { throw new RemoteError('loom/set-not-found', 'evicted', { setId }) })
      .mockImplementationOnce(() => { throw new Error('The queue could not be read') })
    const warn = vi.spyOn(h.ctx.logger, 'warn')
    await h.tools.dispose()
    expect(child.status).toBe('idle')
    expect(warn.mock.calls.flat().join(' ')).toContain('A cancellation observer failed')
    expect(warn.mock.calls.flat().join(' ')).toContain('The queue could not be read')
  })

  it('does not await a child that is no longer live', async () => {
    const h = await harness()
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['a'] })
    const child = live(h, startedIds(value)[0]!)
    await child.whenIdle()
    const get = h.ctx.agents.get.bind(h.ctx.agents)
    vi.spyOn(h.ctx.agents, 'get').mockImplementation(id => id === child.id ? undefined : get(id))
    await h.tools.dispose()
  })

  it('registers the five tools for its lifetime and removes them and its watcher on disposal', async () => {
    const h = await harness({ autoloom: { maxOwnTokens: 100 } })
    const names = (): string[] => h.ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('loom_')).sort()
    expect(names()).toEqual(['loom_cull', 'loom_expand', 'loom_keep', 'loom_read', 'loom_wait'])
    const subject = await story(h)
    const weaver = await session(h, 'weaver')
    const value = await expand(h, weaver, { sessionId: subject.id, afterTurn: 1, lines: ['a'] })
    await waitFor(h, weaver, value.setId)
    const child = live(h, startedIds(value)[0]!)
    await h.tools.dispose()
    expect(names()).toEqual([])
    // Past the budget while running: a loaded watcher would stop the child.
    const cancel = vi.spyOn(child, 'cancel')
    let calls = 0
    h.adapter.respond = () => (calls += 1) === 1 ? toolReply('late-call', 'loom_keep', {}, { inputTokens: 500, outputTokens: 5 }) : textReply('done')
    await run(child, 'late')
    expect(calls).toBe(2)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('fails its load for limits that contradict each other or an interactive or unknown preset', async () => {
    const h = await harness()
    await h.tools.dispose()
    const { ctx } = h
    const ToolLoom = await import('../src/index.ts')
    await expect(ctx.plugin(ToolLoom, { autoloom: { maxUsd: Infinity } })).rejects.toThrow('maxUsd')
    await expect(ctx.plugin(ToolLoom, { autoloom: { maxUsd: 0 } })).rejects.toThrow()
    await expect(ctx.plugin(ToolLoom, { defaultWaitMs: 10, maxWaitMs: 5 })).rejects.toThrow('defaultWaitMs must not exceed maxWaitMs')
    await expect(ctx.plugin(ToolLoom, { defaultReadChars: 10, maxReadChars: 5 })).rejects.toThrow('defaultReadChars must not exceed maxReadChars')
    await expect(ctx.plugin(ToolLoom, { autoloom: { childPermissionPreset: 'read-only' } })).rejects.toThrow('asks for approvals')
    await expect(ctx.plugin(ToolLoom, { autoloom: { childPermissionPreset: 'missing' } })).rejects.toThrow('unknown preset')
    await expect(ctx.plugin(ToolLoom, { autoloom: { maxBranches: 0 } })).rejects.toThrow()
    await expect(ctx.plugin(ToolLoom, { autoloom: { childPermissionPreset: 'loom-child' } })).resolves.toBeDefined()
  })
})
