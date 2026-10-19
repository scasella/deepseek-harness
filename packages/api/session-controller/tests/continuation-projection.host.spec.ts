import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, expect, it } from 'vitest'
import { installContinuationProjection } from '../src/continuation-projection.ts'
import type { SessionRequestId } from '../src/types.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

it('reconstructs only own retry identities and releases its registration on unload', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const source = ctx.sessions.create(SessionId('projection-source'))
  source.append('turn/start', { turn: 1, continuation: { kind: 'user', rpcId: 'inherited' as SessionRequestId } })
  source.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
  const seed = source.snapshotEvents()
  const child = ctx.sessions.create(SessionId('projection-child'), {
    seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { isSeeded: true, parentSession: source.id },
  })
  child.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Existing prompt' }] }), { surfaceOp: 'append' })
  child.append('turn/start', { turn: 2 })
  child.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  child.append('turn/start', { turn: 3, continuation: { kind: 'user' } })
  child.append('turn/end', { turn: 3, reason: { kind: 'blocked' } })
  child.append('turn/start', { turn: 4, continuation: { kind: 'user', rpcId: 'own' as SessionRequestId } })
  child.append('turn/end', { turn: 4, reason: { kind: 'blocked' } })
  const fiber = ctx.plugin({ inject: ['sessionProjections'], apply: installContinuationProjection })
  await fiber
  expect(ctx.sessionProjections.stateOf(child, 'sessionContinuationRequests')).toEqual({
    inheritedEventCount: seed.length, requestIds: ['own'],
  })
  await fiber.dispose()
  expect(ctx.sessionProjections.stateOf(child, 'sessionContinuationRequests')).toBeUndefined()
})
