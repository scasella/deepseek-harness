import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionCheckpoint } from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { tokenUsageProjectionDefinition } from '@deepseek-ai/dsh-token-meter/src/usage-projection.ts'
import type {
  ContextPressureProjection,
  TokenUsageBuckets,
  TokenUsageProjection,
} from '@deepseek-ai/dsh-token-meter/client'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { CompactionId } from '@deepseek-ai/dsh-compaction'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test': { kind: 'test' } & ContextFormed
  }
}

const ZERO: TokenUsageBuckets = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

async function harness(): Promise<{
  ctx: Context
  session: Session
  meterFiber: Awaited<ReturnType<Context['plugin']>>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const meterFiber = await ctx.plugin(TokenMeter)
  return { ctx, session: ctx.sessions.create(), meterFiber }
}

function startStep(session: Session, turn: number, step: number): void {
  session.append('step/start', { turn, step })
}

function usageChunk(
  session: Session,
  usage: TokenUsage,
  turn: number,
  step: number,
): SessionSeq {
  return session.append('assistant/attempt', {
    turn,
    step,
    stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }],
  }).seq
}

function finalUsage(
  session: Session,
  usage: TokenUsage,
  turn: number,
  step: number,
): SessionEvent[] {
  const message = session.append('assistant/message', {
    stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }],
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
    usage,
  }, { surfaceOp: 'append' })
  return [message, session.append('step/end', { turn, step })]
}

const projected = (ctx: Context, session: Session): TokenUsageProjection => {
  const value = ctx.sessionProjections.snapshot(session).values.tokenUsage
  if (value === undefined) throw new Error('tokenUsage projection is not registered')
  return value
}

/**
 * Meter one upcoming replacement the way compaction-basic does: price the
 * replaced span from the measurement service's own nodes and log the
 * shadow-price event directly before the replace.
 */
function appendSummaryMeter(ctx: Context, session: Session, start: SessionSeq, end: SessionSeq): void {
  const nodes = ctx.tokenMeter.measure(session).nodes
  const startIdx = nodes.findIndex(node => node.seq === start)
  const endIdx = nodes.findIndex(node => node.seq === end)
  const shadowed = nodes.slice(startIdx, endIdx + 1)
  session.append('compaction/summary', {
    compactionId: CompactionId('token-usage-summary'),
    summary: [{ type: 'text', text: 'summary' }],
    shadowedRange: { start, end },
    shadowedSeqs: shadowed.map(node => node.seq),
    shadowedTokenCount: shadowed.reduce((total, node) => total + node.tokens, 0),
    provider: 'mock',
    model: 'mock',
  })
}

describe('tokenUsage session projection', () => {
  it('serves zero buckets without usage samples', async () => {
    const { ctx, session } = await harness()
    expect(projected(ctx, session)).toEqual(ZERO)
    session.append('llm/retry-started', {
      retryId: RetryId('token-meter-no-usage-retry'),
      turn: 1,
      step: 1,
      retry: 1,
    })
    expect(projected(ctx, session)).toEqual(ZERO)
  })

  it('does not count a usage chunk and identical final usage twice', async () => {
    const { ctx, session } = await harness()
    const changes: unknown[] = []
    ctx.sessionProjections.onChanged((_session, key, value) => {
      if (key === 'tokenUsage') changes.push(value)
    })
    const usage = {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 7,
      cacheWriteTokens: 2,
      reasoningTokens: 3,
    }
    startStep(session, 1, 1)
    usageChunk(session, usage, 1, 1)
    finalUsage(session, usage, 1, 1)

    expect(projected(ctx, session)).toEqual({
      uncachedInputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 7,
      cacheWriteTokens: 2,
    })
    expect(changes).toHaveLength(1)
  })

  it('replaces an earlier same-step chunk sample with the final usage', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    usageChunk(session, {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
    }, 1, 1)
    finalUsage(session, {
      inputTokens: 14,
      outputTokens: 5,
      cacheReadTokens: 8,
      cacheWriteTokens: 1,
    }, 1, 1)

    expect(projected(ctx, session)).toEqual({
      uncachedInputTokens: 14,
      outputTokens: 5,
      cacheReadTokens: 8,
      cacheWriteTokens: 1,
    })
  })

  it('accumulates retried attempts while replacing samples within each attempt', async () => {
    const { ctx, session } = await harness()
    const retryId = RetryId('token-meter-retry')
    session.append('turn/start', { turn: 1 })
    startStep(session, 1, 1)
    usageChunk(session, {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
    }, 1, 1)
    session.append('assistant/attempt', {
      turn: 1,
      step: 1,
      stream: [{
        type: 'chunk',
        time: 1,
        chunk: {
          type: 'finish',
          reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'busy', status: 429 } },
        },
      }],
    })
    session.append('llm/retry', {
      retryId,
      turn: 1,
      step: 1,
      provider: 'mock',
      mode: 'normal',
      policyKey: 'test',
      retry: 1,
      maxRetries: 1,
      delayMs: 0,
      failure: { code: 'RATE_LIMIT', message: 'busy', status: 429 },
    })
    session.append('llm/retry-started', { retryId, turn: 1, step: 1, retry: 1 })
    usageChunk(session, {
      inputTokens: 12,
      outputTokens: 4,
      cacheReadTokens: 6,
    }, 1, 1)
    finalUsage(session, {
      inputTokens: 14,
      outputTokens: 5,
      cacheReadTokens: 8,
      cacheWriteTokens: 1,
    }, 1, 1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    expect(projected(ctx, session)).toEqual({
      uncachedInputTokens: 24,
      outputTokens: 7,
      cacheReadTokens: 11,
      cacheWriteTokens: 1,
    })
  })

  it('accumulates disjoint buckets across steps without adding reasoning twice', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    usageChunk(session, {
      inputTokens: 10,
      outputTokens: 6,
      reasoningTokens: 5,
      cacheReadTokens: 2,
    }, 1, 1)
    finalUsage(session, {
      inputTokens: 10,
      outputTokens: 6,
      reasoningTokens: 5,
      cacheReadTokens: 2,
    }, 1, 1)
    startStep(session, 1, 2)
    usageChunk(session, {
      inputTokens: 20,
      outputTokens: 9,
      reasoningTokens: 7,
      cacheWriteTokens: 4,
    }, 1, 2)
    finalUsage(session, {
      inputTokens: 20,
      outputTokens: 9,
      reasoningTokens: 7,
      cacheWriteTokens: 4,
    }, 1, 2)

    expect(projected(ctx, session)).toEqual({
      uncachedInputTokens: 30,
      outputTokens: 15,
      cacheReadTokens: 2,
      cacheWriteTokens: 4,
    })
  })

  it('retains a usage chunk when the request produces no final assistant message', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    usageChunk(session, { inputTokens: 9, outputTokens: 1 }, 1, 1)
    session.append('step/end', { turn: 1, step: 1 })
    expect(projected(ctx, session)).toEqual({
      uncachedInputTokens: 9,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('does not erase historical billing when the visible surface is replaced', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    usageChunk(session, { inputTokens: 12, outputTokens: 3 }, 1, 1)
    finalUsage(session, { inputTokens: 12, outputTokens: 3 }, 1, 1)
    const before = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'before compaction' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    appendSummaryMeter(ctx, session, before.seq, before.seq)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted' }],
      source: { kind: 'test' },
    }), {
      surfaceOp: { op: 'replace', startSeq: before.seq, endSeq: before.seq },
      sourceEventSeqs: [before.seq],
    })

    expect(projected(ctx, session)).toEqual({
      uncachedInputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('unregisters with the token-meter fiber and restores from a JSON checkpoint', async () => {
    const { ctx, session, meterFiber } = await harness()
    startStep(session, 1, 1)
    usageChunk(session, { inputTokens: 8, outputTokens: 2, cacheReadTokens: 5 }, 1, 1)
    const checkpoint = JSON.parse(JSON.stringify(
      ctx.sessionProjections.checkpoint(session),
    )) as ReturnType<typeof ctx.sessionProjections.checkpoint>

    await meterFiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('tokenUsage')

    await ctx.plugin(TokenMeter)
    expect(ctx.sessionProjections.viewCheckpoint(checkpoint).tokenUsage).toEqual({
      uncachedInputTokens: 8,
      outputTokens: 2,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
    })
  })
})

/** Sum bucket sets field by field. */
function sum(...parts: readonly TokenUsageBuckets[]): TokenUsageBuckets {
  return parts.reduce((total, part) => ({
    uncachedInputTokens: total.uncachedInputTokens + part.uncachedInputTokens,
    outputTokens: total.outputTokens + part.outputTokens,
    cacheReadTokens: total.cacheReadTokens + part.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + part.cacheWriteTokens,
  }), ZERO)
}

/** Buckets of one sample without reasoning or optional cache fields. */
const buckets = (inputTokens: number, outputTokens: number, cacheReadTokens = 0): TokenUsageBuckets => ({
  uncachedInputTokens: inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens: 0,
})

/** Append one completed single-step turn reporting `usage`; returns its events in order. */
function usageTurn(session: Session, turn: number, usage: TokenUsage): SessionEvent[] {
  return [
    session.append('turn/start', { turn }),
    session.append('step/start', { turn, step: 1 }),
    ...finalUsage(session, usage, turn, 1),
    session.append('turn/end', { turn, reason: { kind: 'completed' } }),
  ]
}

describe('tokenUsage fork split', () => {
  it('splits a fork and a fork of that fork at their cuts while the totals cover the whole log', async () => {
    const { ctx, session: root } = await harness()
    const rootCut = usageTurn(root, 1, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 }).at(-1)!.seq
    // Root usage after the cut never reaches the child.
    usageTurn(root, 2, { inputTokens: 5_000, outputTokens: 500 })
    const first = buckets(100, 10, 900)

    const child = ctx.sessions.fork(root, rootCut, SessionId('usage-child'))
    expect(projected(ctx, child)).toEqual({ ...first, fork: { own: ZERO, inherited: first } })
    const childCut = usageTurn(child, 2, { inputTokens: 20, outputTokens: 4, cacheReadTokens: 980 }).at(-1)!.seq
    const second = buckets(20, 4, 980)
    expect(projected(ctx, child)).toEqual({ ...sum(first, second), fork: { own: second, inherited: first } })
    usageTurn(child, 3, { inputTokens: 7_000, outputTokens: 700 })

    // The grandchild inherits the root's turn and the child's own turn before its cut.
    const grandchild = ctx.sessions.fork(child, childCut, SessionId('usage-grandchild'))
    expect(projected(ctx, grandchild)).toEqual({
      ...sum(first, second),
      fork: { own: ZERO, inherited: sum(first, second) },
    })
    usageTurn(grandchild, 3, { inputTokens: 30, outputTokens: 6, cacheReadTokens: 1_970 })
    const third = buckets(30, 6, 1_970)
    expect(projected(ctx, grandchild)).toEqual({
      ...sum(first, second, third),
      fork: { own: third, inherited: sum(first, second) },
    })
    // A Session that is not a fork carries no split.
    expect(projected(ctx, root)).toEqual(sum(first, buckets(5_000, 500)))
  })

  it('keeps an inherited streaming sample when the cut precedes its final message', async () => {
    const { ctx, session: root } = await harness()
    root.append('turn/start', { turn: 1 })
    startStep(root, 1, 1)
    const cut = usageChunk(root, { inputTokens: 40, outputTokens: 2 }, 1, 1)
    finalUsage(root, { inputTokens: 40, outputTokens: 9 }, 1, 1)

    // The seed's synthetic step/end and turn/end follow the cut and carry no usage.
    const child = ctx.sessions.fork(root, cut, SessionId('usage-mid-step'))
    expect(projected(ctx, child)).toEqual({
      ...buckets(40, 2),
      fork: { own: ZERO, inherited: buckets(40, 2) },
    })
    usageTurn(child, 2, { inputTokens: 8, outputTokens: 1 })
    expect(projected(ctx, child)).toEqual({
      ...buckets(48, 3),
      fork: { own: buckets(8, 1), inherited: buckets(40, 2) },
    })
  })

  it('never lets an own sample replace an inherited sample of the same attempt', () => {
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('direct'), createdAt: 0, isSeeded: true }
    const sample = (seq: number, usage: TokenUsage): SessionEvent<'assistant/attempt'> => ({
      type: 'assistant/attempt',
      seq: SessionSeq(seq),
      time: 0,
      data: { turn: 1, step: 1, stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }] },
    })
    const definition = tokenUsageProjectionDefinition
    const inherited = definition.apply(definition.init(header, SessionLogOffset(1)), sample(0, { inputTokens: 10, outputTokens: 1 }))
    const both = definition.apply(inherited, sample(1, { inputTokens: 12, outputTokens: 3 }))
    expect(definition.wire.view(both)).toEqual({
      ...buckets(22, 4),
      fork: { own: buckets(12, 3), inherited: buckets(10, 1) },
    })
    // A later own sample of the same attempt replaces only the own sample.
    const replaced = definition.apply(both, sample(2, { inputTokens: 13, outputTokens: 5 }))
    expect(definition.wire.view(replaced)).toEqual({
      ...buckets(23, 6),
      fork: { own: buckets(13, 5), inherited: buckets(10, 1) },
    })
  })

  it('restores a current fork checkpoint and refolds a stateVersion 2 row from init', async () => {
    const { ctx, session: root } = await harness()
    const events = usageTurn(root, 1, { inputTokens: 100, outputTokens: 10 })
    const cut = events.at(-1)!.seq
    events.push(...usageTurn(root, 2, { inputTokens: 30, outputTokens: 3 }))

    const child = ctx.sessions.fork(root, cut, SessionId('usage-cached-child'))
    const checkpoint = JSON.parse(JSON.stringify(
      ctx.sessionProjections.checkpoint(child),
    )) as ProjectionCheckpoint
    expect(checkpoint.tokenUsage?.ver).toBe(3)
    expect(ctx.sessionProjections.viewCheckpoint(checkpoint).tokenUsage).toEqual(projected(ctx, child))

    // A whole-log row has no own/inherited sides: the version gate discards it
    // and the key refolds from init over the log.
    const stale: ProjectionCheckpoint = {
      tokenUsage: {
        ver: 2,
        seq: events.at(-1)!.seq,
        val: { totals: buckets(130, 13), last: { turn: 2, step: 1, buckets: buckets(30, 3) } },
      },
    }
    expect(ctx.sessionProjections.viewCheckpoint(stale)).not.toHaveProperty('tokenUsage')
    const restored = ctx.sessionProjections.restore(
      stale, events, SessionLogOffset(0), root.header, SessionLogOffset(cut + 1),
    )
    expect(restored.snapshot.values.tokenUsage).toEqual({
      ...buckets(130, 13),
      fork: { own: buckets(30, 3), inherited: buckets(100, 10) },
    })
    expect(restored.checkpoint.tokenUsage?.ver).toBe(3)
  })
})

const pressure = (ctx: Context, session: Session): ContextPressureProjection => {
  const value = ctx.sessionProjections.snapshot(session).values.contextPressure
  if (value === undefined) throw new Error('contextPressure projection is not registered')
  return value
}

function recordContext(session: Session, model: string, contextWindow?: number): void {
  session.append('request/context', {
    provider: 'mock',
    model,
    ...contextWindow === undefined ? {} : { contextWindow },
  })
}

/** Append one model-visible user turn and return its surface seq. */
function appendUser(session: Session, text: string): SessionSeq {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

/** Append one finalized assistant turn carrying its provider usage. */
function appendAssistant(
  session: Session,
  text: string,
  usage: TokenUsage,
  turn: number,
  step: number,
): SessionSeq {
  return session.append('assistant/message', {
    stream: [],
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
    usage,
  }, { surfaceOp: 'append' }).seq
}

describe('contextPressure session projection', () => {
  it('serves no pressure or capacity for an empty log', async () => {
    const { ctx, session } = await harness()
    expect(pressure(ctx, session)).toEqual({})
  })

  it('does not synthesize zero pressure before a provider usage sample', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    recordContext(session, 'small', 64_000)
    expect(pressure(ctx, session)).toEqual({ contextWindow: 64_000 })
  })

  it('sums prompt-side buckets and excludes response output', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    usageChunk(session, {
      inputTokens: 100,
      outputTokens: 4_000,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
    }, 1, 1)
    // Output is deliberately absent: occupancy describes the prompt that was
    // sent, so it holds still while the response streams.
    expect(pressure(ctx, session).pressureTokens).toBe(125)
  })

  it('replaces pressure with the newest request rather than accumulating', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    usageChunk(session, { inputTokens: 100, outputTokens: 10 }, 1, 1)
    finalUsage(session, { inputTokens: 100, outputTokens: 10 }, 1, 1)
    startStep(session, 2, 1)
    usageChunk(session, { inputTokens: 250, outputTokens: 10 }, 2, 1)
    expect(pressure(ctx, session).pressureTokens).toBe(250)
  })

  it('carries the newest recorded capacity and replaces it on a model switch', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    recordContext(session, 'small', 64_000)
    usageChunk(session, { inputTokens: 100, outputTokens: 10 }, 1, 1)
    expect(pressure(ctx, session)).toEqual({
      pressureTokens: 100, projectedTokens: 100, contextWindow: 64_000,
    })
    recordContext(session, 'large', 256_000)
    expect(pressure(ctx, session)).toEqual({
      pressureTokens: 100, projectedTokens: 100, contextWindow: 256_000,
    })
  })

  it('removes an older capacity when the newest route advertises none', async () => {
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    recordContext(session, 'small', 64_000)
    usageChunk(session, { inputTokens: 100, outputTokens: 10 }, 1, 1)
    recordContext(session, 'unknown')
    expect(pressure(ctx, session)).toEqual({ pressureTokens: 100, projectedTokens: 100 })
  })

  it('pushes no change for unrelated events or a restated capacity', async () => {
    // The registry gates its change feed on Object.is, so a unit that rebuilt
    // state for an event it does not care about would push phantom updates.
    const { ctx, session } = await harness()
    startStep(session, 1, 1)
    recordContext(session, 'small', 64_000)
    usageChunk(session, { inputTokens: 100, outputTokens: 10 }, 1, 1)
    const changed: string[] = []
    ctx.sessionProjections.onChanged((_session, key) => { changed.push(key) })

    session.append('session/end-seed', {})
    expect(changed).not.toContain('contextPressure')
    // A repeated capacity record for the same window is also a no-op.
    recordContext(session, 'small', 64_000)
    expect(changed).not.toContain('contextPressure')
    // A real capacity change still reports.
    recordContext(session, 'large', 256_000)
    expect(changed).toContain('contextPressure')
  })

  it('restores from a JSON checkpoint and unregisters with the token-meter fiber', async () => {
    const { ctx, session, meterFiber } = await harness()
    startStep(session, 1, 1)
    recordContext(session, 'small', 64_000)
    usageChunk(session, { inputTokens: 42, outputTokens: 2 }, 1, 1)
    const checkpoint = JSON.parse(JSON.stringify(
      ctx.sessionProjections.checkpoint(session),
    )) as ReturnType<typeof ctx.sessionProjections.checkpoint>
    expect(checkpoint.contextPressure?.ver).toBe(5)

    await meterFiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('contextPressure')

    await ctx.plugin(TokenMeter)
    expect(ctx.sessionProjections.viewCheckpoint(checkpoint).contextPressure).toEqual({
      pressureTokens: 42,
      projectedTokens: 42,
      contextWindow: 64_000,
    })
  })

  it('carries the sample forward over surface growth and a compaction', async () => {
    const { ctx, session } = await harness()
    recordContext(session, 'large', 128_000)
    const question = appendUser(session, 'a first question worth a few tokens')
    startStep(session, 1, 1)
    // The provider prices the prompt its request actually carried; the sample
    // must anchor against the surface as of that request, not after the
    // assistant message joins it.
    const answer = appendAssistant(session, 'an answer of some length', { inputTokens: 900, outputTokens: 20 }, 1, 1)
    session.append('step/end', { turn: 1, step: 1 })
    const afterTurn = pressure(ctx, session)
    expect(afterTurn.pressureTokens).toBe(900)
    // The assistant message landed after the sample, so it already shows.
    expect(afterTurn.projectedTokens).toBeGreaterThan(900)

    const grown = appendUser(session, 'a follow-up question that grows the surface further')
    const beforeCompaction = pressure(ctx, session).projectedTokens
    expect(beforeCompaction).toBeGreaterThan(afterTurn.projectedTokens!)

    // Compaction reports no usage of its own, so `pressureTokens` cannot move;
    // the projected figure must shrink anyway — the defect this field fixes.
    appendSummaryMeter(ctx, session, question, grown)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'test' },
    }), {
      surfaceOp: { op: 'replace', startSeq: question, endSeq: grown },
      sourceEventSeqs: [question, answer, grown],
    })
    const compacted = pressure(ctx, session)
    expect(compacted.pressureTokens).toBe(900)
    expect(compacted.projectedTokens).toBeLessThan(beforeCompaction!)
  })

  it.each(['start', 'end'] as const)('rejects a shadow claim with a mismatched %s endpoint', async (endpoint) => {
    const { ctx, session } = await harness()
    try {
      const first = appendUser(session, 'first')
      const last = appendUser(session, 'last')
      appendSummaryMeter(ctx, session, first, last)
      const target = endpoint === 'start' ? last : first
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'summary' }], source: { kind: 'test' },
      }), { surfaceOp: { op: 'replace', startSeq: target, endSeq: target }, sourceEventSeqs: [target] })
      expect(() => pressure(ctx, session)).toThrow('has no adjacent shadow price')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('folds a replacement without a claim at zero', async () => {
    const { ctx, session } = await harness()
    const question = appendUser(session, 'a question from an unmetered log')
    startStep(session, 1, 1)
    usageChunk(session, { inputTokens: 100, outputTokens: 1 }, 1, 1)
    session.append('step/end', { turn: 1, step: 1 })
    const before = pressure(ctx, session)

    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary without a preceding claim' }],
      source: { kind: 'test' },
    }), {
      surfaceOp: { op: 'replace', startSeq: question, endSeq: question },
      sourceEventSeqs: [question],
    })

    expect(pressure(ctx, session)).toEqual(before)
  })

  it('clamps a projection that heuristic error drove below zero', async () => {
    const { ctx, session } = await harness()
    recordContext(session, 'large', 128_000)
    const question = appendUser(session, 'a question long enough to outprice the sample'.repeat(4))
    startStep(session, 1, 1)
    // A provider sample far below the heuristic price of what it replaced:
    // shadowing that span subtracts more than the sample holds.
    appendAssistant(session, 'ok', { inputTokens: 3, outputTokens: 1 }, 1, 1)
    session.append('step/end', { turn: 1, step: 1 })
    appendSummaryMeter(ctx, session, question, question)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '.' }],
      source: { kind: 'test' },
    }), {
      surfaceOp: { op: 'replace', startSeq: question, endSeq: question },
      sourceEventSeqs: [question],
    })
    expect(pressure(ctx, session).projectedTokens).toBe(0)
  })
})
