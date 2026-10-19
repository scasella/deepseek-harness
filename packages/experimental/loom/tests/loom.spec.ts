/** The Loom service owns the `loomBranch` unit, telemetry redaction, and the fork-family Remote for its plugin lifetime. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionProjectionHints, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import SessionStore, { appendPluginRecord, SessionId, SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'
import type { RemoteAccessResource } from '@deepseek-ai/dsh-typert-protocol'
import Loom from '../src/index.ts'
import { loomBranchProjection } from '../src/projection.ts'
import type { LoomBranchRecord, LoomRunId, LoomSetId } from '../src/types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Test-only record outside the Loom branch type. */
    'plugin:loom/test-other': { readonly note: string }
  }
}

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => root.fiber.dispose())) })

const SOURCE = SessionId('source')

function branch(overrides: Partial<LoomBranchRecord> = {}): LoomBranchRecord {
  return {
    version: 1,
    setId: brandString<LoomSetId>('set-1'),
    sourceSessionId: SOURCE,
    atSeq: SessionSeq(0),
    variant: 1,
    variantCount: 2,
    kind: 'regenerate',
    ...overrides,
  }
}

function summary(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { agentAvailable: false, sessionId: SessionId(id), updatedAt: 1, running: false, blank: false, ...extra }
}

interface Fixture {
  readonly ctx: Context
  readonly list: ReturnType<typeof vi.fn>
  readonly hidden: Set<string>
}

async function fixture(items: readonly SessionSummary[] = []): Promise<Fixture> {
  const ctx = new Context()
  roots.push(ctx)
  const hidden = new Set<string>()
  const list = vi.fn(async (_request: object, _signal: AbortSignal) => ({ items }))
  ctx.provide('sessionController', { list } as never)
  ctx.provide('remoteAccess', { allows: (resource: RemoteAccessResource) => !('id' in resource && hidden.has(resource.id)) } as never)
  ctx.provide('typert', {} as never)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return { ctx, list, hidden }
}

function ledger(type: string, body: unknown): SessionTelemetryRecord {
  return {
    sourceEvent: { sessionId: SOURCE, envelope: { type, seq: SessionSeq(3), time: 1 } as never },
    channel: 'ledger',
    time: 1,
    severity: 'info',
    attributes: { 'event.type': type },
    body,
  }
}

function waterfall(ctx: Context, record: SessionTelemetryRecord): SessionTelemetryRecord {
  return ctx.waterfall('session-telemetry/record', record, () => record)
}

describe('Loom service', () => {
  it('registers loomBranch and redaction for its plugin lifetime', async () => {
    const { ctx } = await fixture()
    const fiber = ctx.plugin(Loom)
    await fiber
    const session = ctx.sessions.create(SOURCE)
    expect(ctx.sessionProjections.stateOf(session, 'loomBranch')).toEqual({ inheritedEventCount: 0, branch: null })
    expect(waterfall(ctx, ledger('plugin:loom/branch', { secret: true })).body).toBeNull()
    await fiber.dispose()
    expect(ctx.sessionProjections.stateOf(session, 'loomBranch')).toBeUndefined()
    expect(waterfall(ctx, ledger('plugin:loom/branch', { secret: true })).body).toEqual({ secret: true })
  })
})

describe('loomBranch projection', () => {
  async function projected(): Promise<{ ctx: Context; source: Session }> {
    const { ctx } = await fixture()
    ctx.sessionProjections.register(loomBranchProjection)
    return { ctx, source: ctx.sessions.create(SOURCE) }
  }

  it('keeps the first valid own branch record and publishes it as the client view', async () => {
    const { ctx, source } = await projected()
    appendPluginRecord(source, 'plugin:loom/test-other', { note: 'other' })
    appendPluginRecord(source, 'plugin:loom/branch', branch({ variant: 3, variantCount: 2 }))
    expect(ctx.sessionProjections.stateOf(source, 'loomBranch')).toEqual({ inheritedEventCount: 0, branch: null })
    appendPluginRecord(source, 'plugin:loom/branch', branch({ variantKey: 'k', runId: brandString<LoomRunId>('run') }))
    const first = ctx.sessionProjections.stateOf(source, 'loomBranch')
    appendPluginRecord(source, 'plugin:loom/branch', branch({ variant: 2 }))
    expect(ctx.sessionProjections.stateOf(source, 'loomBranch')).toBe(first)
    expect(first).toEqual({ inheritedEventCount: 0, branch: branch({ variantKey: 'k', runId: brandString<LoomRunId>('run') }) })
    expect(ctx.sessionProjections.snapshot(source, ['loomBranch']).values.loomBranch).toEqual(first)
  })

  it('ignores branch records a fork inherited and takes its own after the cut', async () => {
    const { ctx, source } = await projected()
    appendPluginRecord(source, 'plugin:loom/branch', branch())
    const child = ctx.sessions.fork(source)
    expect(ctx.sessionProjections.stateOf(child, 'loomBranch')).toEqual({ inheritedEventCount: 1, branch: null })
    const own = branch({ sourceSessionId: SOURCE, atSeq: SessionSeq(0), setId: brandString<LoomSetId>('set-2') })
    appendPluginRecord(child, 'plugin:loom/branch', own)
    expect(ctx.sessionProjections.stateOf(child, 'loomBranch')).toEqual({ inheritedEventCount: 1, branch: own })
  })

  it('refuses persisted state that is not a valid view', () => {
    expect(loomBranchProjection.stateSchema.safeParse({ inheritedEventCount: -1, branch: null }).success).toBe(false)
    expect(loomBranchProjection.stateSchema.safeParse({ inheritedEventCount: 2, branch: branch(), extra: 1 }).success).toBe(false)
    expect(loomBranchProjection.stateSchema.parse({ inheritedEventCount: 2, branch: branch() }))
      .toEqual({ inheritedEventCount: 2, branch: branch() })
  })
})

describe('telemetry redaction', () => {
  it('removes Loom payloads, keeps the envelope, and passes other records through the rules beneath', async () => {
    const { ctx } = await fixture()
    await ctx.plugin(Loom)
    const loom = ledger('plugin:loom/branch', { setId: 'set-1' })
    expect(waterfall(ctx, loom)).toEqual({ ...loom, body: null })
    const other = ledger('user/message', { text: 'kept' })
    expect(waterfall(ctx, other)).toBe(other)
    const ops: SessionTelemetryRecord = { channel: 'ops', time: 1, severity: 'error', attributes: { 'telemetry.op': 'shutdown' }, body: {} }
    expect(waterfall(ctx, ops)).toBe(ops)
  })
})

describe('loom.family', () => {
  it('reads the visible fork family through the Session list', async () => {
    const lineage = (createdAt: number): SessionProjectionHints => ({
      kind: 'sequenced',
      asOfSeq: 1,
      values: { forkLineage: { parentSession: SessionId('root'), cutSeq: SessionSeq(0), createdAt } },
    })
    const { ctx, list, hidden } = await fixture([
      summary('root'),
      summary('c', { parentSessionId: SessionId('root'), updatedAt: 9, projections: lineage(30) }),
      summary('a', { parentSessionId: SessionId('root'), running: true, projections: lineage(10) }),
      summary('b', { parentSessionId: SessionId('root'), projections: lineage(20) }),
      summary('helper', { parentSessionId: SessionId('a'), origin: 'subagent' }),
    ])
    await ctx.plugin(Loom)
    hidden.add('b')
    const signal = new AbortController().signal
    const family = await ctx.loom.family({ sessionId: SessionId('a') }, signal)
    expect(list).toHaveBeenCalledWith({}, signal)
    expect(family).toEqual({
      rootId: 'root',
      focusId: 'a',
      nodes: [
        { id: 'root', sessionId: 'root', depth: 0, updatedAt: 1, running: false, blank: false },
        { id: 'a', sessionId: 'a', parentId: 'root', depth: 1, createdAt: 10, updatedAt: 1, running: true, blank: false },
        { id: 'c', sessionId: 'c', parentId: 'root', depth: 1, createdAt: 30, updatedAt: 9, running: false, blank: false },
      ],
    })
  })

  it('reports a Session the caller cannot list as not found', async () => {
    const { ctx, hidden } = await fixture([summary('root')])
    await ctx.plugin(Loom)
    hidden.add('root')
    await expect(ctx.loom.family({ sessionId: SessionId('root') }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'session/not-found', details: { sessionId: 'root' } })
  })
})
