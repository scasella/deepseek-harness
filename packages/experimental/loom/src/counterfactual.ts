/** Forked content-only tool-result replacements, followed by an explicit continuation. */
import type { Context } from '@deepseek-ai/cordis'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, foldSurface, SessionSeq } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { inspectSession } from './inspect.ts'
import type { LoomCounterfactualRequest, LoomCounterfactualValue } from './s6-types.ts'

/**
 * Fork at a current tool result's completed step, replace only its content,
 * then request a model turn from that recorded result. The source is never written.
 * @param ctx - Loom Host context.
 * @param request - current result and replacement text blocks.
 * @param source - durable initiator of the child continuation.
 * @param signal - cancellation before the fork and child admission.
 * @returns the new Session and its replacement event.
 */
export async function counterfactual(
  ctx: Context,
  request: LoomCounterfactualRequest,
  source: MessageSource,
  signal: AbortSignal,
): Promise<LoomCounterfactualValue> {
  const inspected = await inspectSession(ctx, request.sessionId, signal)
  signal.throwIfAborted()
  const original = inspected.events[request.resultSeq]
  const surface = foldSurface(inspected.events, ctx.sessions.messageProjections)
  if (original?.type !== 'tool/result' || !surface.nodes.includes(request.resultSeq)) {
    throw new RemoteError('loom/counterfactual-unavailable', 'Select a current recorded tool result before branching its output.', {
      sessionId: request.sessionId, resultSeq: request.resultSeq,
    })
  }
  const stepEnd = inspected.events.find(event => event.seq >= original.seq && event.type === 'step/end'
    && event.data.turn === original.data.turn && event.data.step === original.data.step)
  const closedBeforeRewrite = original.surfaceOp !== 'append' && inspected.events.some(event => event.seq < original.seq
    && event.type === 'step/end' && event.data.turn === original.data.turn && event.data.step === original.data.step)
  if (stepEnd === undefined && !closedBeforeRewrite) throw new RemoteError('loom/counterfactual-unavailable',
    'Wait for every tool in this step to finish before branching its output.', { sessionId: request.sessionId, resultSeq: original.seq })
  const fork = await ctx.sessionController.fork({ sessionId: request.sessionId, atSeq: stepEnd?.seq ?? original.seq })
  try {
    const resolved = await ctx.sessionController.resolveAgent(fork.sessionId)
    if ('error' in resolved) throw resolved.error
    const { agent } = resolved
    await agent.runMaintenance(async (maintenanceSignal) => {
      AbortSignal.any([signal, maintenanceSignal]).throwIfAborted()
      agent.inbox.clear()
      await ctx.sessions.flush(agent.session)
    })
    signal.throwIfAborted()
    const written = Promise.withResolvers<SessionSeq>()
    let entered = false
    // Released readers require tool-result replacements inside an open turn.
    const stop = agent.ctx.on('agent/pre-step', async (payload, next) => {
      entered = true
      stop()
      try {
        AbortSignal.any([signal, payload.signal]).throwIfAborted()
        const seq = SessionSeq(agent.session.seq + 1)
        appendPluginRecord(agent.session, 'plugin:loom/tool-result-override', {
          version: 1, sourceSessionId: request.sessionId, resultSeq: original.seq, replacementSeq: seq,
        })
        const replacement = agent.session.append('tool/result', {
          ...original.data,
          message: { ...original.data.message, content: [...request.content] },
        }, {
          surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq],
        })
        await ctx.sessions.flush(agent.session)
        written.resolve(replacement.seq)
      } catch (error: unknown) {
        written.reject(error)
        throw error
      }
      return next()
    })
    try {
      agent.continue(source)
      void agent.whenIdle().then(() => {
        if (!entered) written.reject(new Error('The continuation stopped before its tool-result replacement could be recorded.'))
      }, (error: unknown) => { written.reject(error) })
      return { sessionId: agent.id, replacementSeq: await written.promise }
    } finally {
      stop()
    }
  } catch (error: unknown) {
    throw new RemoteError('loom/counterfactual-incomplete',
      'The counterfactual branch exists but could not start its continuation. Open that branch to inspect its recorded result.',
      { sessionId: request.sessionId, childSessionId: fork.sessionId, reason: String(error) }, { cause: error })
  }
}
