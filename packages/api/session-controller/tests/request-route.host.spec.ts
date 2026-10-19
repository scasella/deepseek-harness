/** Routes read from logged request headers and the route a fork cut leaves its child. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { EpochHeader, Session } from '@deepseek-ai/dsh-session'
import { firstRequestRoute, headerRoute } from '../src/request-route.ts'

async function source(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return { ctx, session: ctx.sessions.create(SessionId('route-source'), { meta: { cwd: '/proj' } }) }
}

function openTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `prompt ${String(turn)}` }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

const high: EpochHeader = {
  config: { provider: 'first-provider', model: 'first-model', reasoningEffort: ReasoningEffortId('high') },
}

describe('headerRoute', () => {
  it('keeps an explicit effort and drops one the adapter defaulted', () => {
    expect(headerRoute(high)).toEqual({ provider: 'first-provider', model: 'first-model', reasoningEffort: 'high' })
    expect(headerRoute({ ...high, adapterDefaults: { reasoningEffort: true } }))
      .toEqual({ provider: 'first-provider', model: 'first-model' })
    expect(headerRoute({ config: { provider: 'plain', model: 'plain-model' } }))
      .toEqual({ provider: 'plain', model: 'plain-model' })
  })
})

describe('firstRequestRoute', () => {
  it('returns the first logged route when the cut precedes every request header and pick', async () => {
    const { ctx, session } = await source()
    openTurn(session, 1)
    const cut = session.snapshotEvents().at(-1)
    session.append('request/header', { header: high, reason: 'initial' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('model/selection', { provider: 'picked', model: 'picked-model' })
    openTurn(session, 2)
    session.append('request/header', {
      header: { config: { provider: 'picked', model: 'picked-model' } }, reason: 'change',
    })

    expect(cut?.type).toBe('user/message')
    expect(firstRequestRoute(session.snapshotEvents(), cut?.seq ?? SessionSeq(0)))
      .toEqual({ provider: 'first-provider', model: 'first-model', reasoningEffort: 'high' })
    await ctx.fiber.dispose()
  })

  it('returns nothing when the prefix holds a pick no header consumed', async () => {
    const { ctx, session } = await source()
    const pick = session.append('model/selection', { provider: 'early-pick', model: 'early-model' })
    session.append('model/selection', { provider: 'first-provider', model: 'first-model', reasoningEffort: 'high' })
    openTurn(session, 1)
    session.append('request/header', { header: high, reason: 'initial' })

    expect(firstRequestRoute(session.snapshotEvents(), pick.seq)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('returns nothing when the prefix holds a header or the source logged none', async () => {
    const { ctx, session } = await source()
    openTurn(session, 1)
    expect(firstRequestRoute(session.snapshotEvents(), SessionSeq(0))).toBeUndefined()
    const header = session.append('request/header', { header: high, reason: 'initial' })
    const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    expect(firstRequestRoute(session.snapshotEvents(), header.seq)).toBeUndefined()
    expect(firstRequestRoute(session.snapshotEvents(), end.seq)).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
