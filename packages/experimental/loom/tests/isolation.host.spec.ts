/**
 * Worktree isolation of branch children over real temporary Git repositories:
 * distinct checkouts from one snapshot base, refusals before any fork, apply
 * into the source folder with dirty and conflict refusals, and removal of only
 * the worktrees Loom created.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { pluginRecordOf, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import { loomIsolationRecordSchema } from '../src/records.ts'
import type { LoomBranchRequest, LoomBranchRequestId, LoomBranchValue, LoomIsolationRecord } from '../src/types.ts'
import { git, mountWorkspaceHost, removeAll, repository, scratch, type WorkspaceHost, type WorkspaceHostOptions } from './workspace-host.ts'

const SIGNAL = new AbortController().signal
const sandboxUsable = await (async () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return false
  const probe = new Context()
  try {
    await probe.plugin(LocalSandbox)
    await probe.sandbox.confine([process.execPath, '--version'], { mode: 'read-only', workspaceRoot: process.cwd() })
    return true
  } catch (error: unknown) {
    if (error instanceof SandboxUnavailableError) return false
    throw error
  } finally {
    await probe.fiber.dispose()
  }
})()

const hosts: WorkspaceHost[] = []
const ANY_SESSION = expect.any(String) as SessionId
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) await host.ctx.fiber.dispose()
  await removeAll(directories.splice(0))
})

async function host(options: Partial<WorkspaceHostOptions> & { readonly workspaceRoot: string }): Promise<WorkspaceHost> {
  const mounted = await mountWorkspaceHost({ mode: 'danger-full-access', ...options })
  hosts.push(mounted)
  return mounted
}

async function folder(prefix = 'dsh-loom-isolation-'): Promise<string> {
  const path = await scratch(prefix)
  directories.push(path)
  return path
}

let requests = 0
function requestId(): LoomBranchRequestId {
  requests += 1
  return brandString<LoomBranchRequestId>(`isolation-${String(requests)}`)
}

/** A source Session in `cwd` that ran one turn under `mode`. */
async function source(h: WorkspaceHost, cwd: string, mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'danger-full-access'): Promise<Agent> {
  requests += 1
  const agent = await h.agents.create(SessionId(`source-${String(requests)}`), { provider: 'mock', model: 'mock' }, { cwd })
  setSandboxMode(agent.session, mode)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return agent
}

function steer(sessionId: SessionId, lines: readonly string[], extra: Partial<LoomBranchRequest> = {}): LoomBranchRequest {
  return { sessionId, requestId: requestId(), kind: 'steer', afterTurn: 1, lines, isolation: 'worktree', ...extra } as LoomBranchRequest
}

/** Every started child's Agent, after it went idle. */
async function settled(h: WorkspaceHost, value: LoomBranchValue): Promise<Agent[]> {
  const agents: Agent[] = []
  for (const child of value.children) {
    if (child.state !== 'started') throw new Error(`child ${String(child.index)} did not start: ${JSON.stringify(child)}`)
    const agent = h.ctx.agents.get(child.sessionId)
    if (agent === undefined) throw new Error(`child ${child.sessionId} is not live`)
    await agent.whenIdle()
    agents.push(agent)
  }
  return agents
}

function own(agent: Agent): SessionEvent[] {
  return agent.session.snapshotEvents().slice(agent.session.inheritedEventCount)
}

function isolationOf(agent: Agent): LoomIsolationRecord {
  const record = own(agent).map(pluginRecordOf).find(found => found?.type === 'plugin:loom/isolation')
  return loomIsolationRecordSchema.parse(record?.data)
}

describe('worktree isolation', () => {
  it('gives each child its own checkout from one base that carries uncommitted tracked changes, and runs them at once', async () => {
    const root = await folder()
    await repository(root)
    await writeFile(join(root, 'tracked.txt'), 'work in progress\n')
    await writeFile(join(root, 'scratch.txt'), 'untracked\n')
    const h = await host({ workspaceRoot: root })
    const from = await source(h, root)
    const head = await git(root, 'rev-parse', 'HEAD')

    const value = await h.ctx.loom.branch(steer(from.id, ['write notes.txt: alpha', 'write notes.txt: beta']))

    expect(value.children.map(child => child.state)).toEqual(['started', 'started'])
    const [first, second] = await settled(h, value)
    const [a, b] = [isolationOf(first!), isolationOf(second!)]
    expect(a.worktreePath).toBe(join(root, '.agents/worktrees/loom', first!.id))
    expect(b.worktreePath).toBe(join(root, '.agents/worktrees/loom', second!.id))
    expect([a.branchName, b.branchName]).toEqual([`loom/${first!.id}`, `loom/${second!.id}`])
    expect(a.baseCommit).toBe(b.baseCommit)
    expect(a.baseCommit).not.toBe(head)
    expect(await git(root, 'rev-parse', `${a.baseCommit}^@`)).toBe(head)
    expect(a).toEqual({ ...a, version: 1, repositoryRoot: root })
    expect(Object.keys(a).sort()).toEqual(['baseCommit', 'branchName', 'repositoryRoot', 'version', 'worktreePath'])
    expect(await readFile(join(a.worktreePath, 'notes.txt'), 'utf8')).toBe('alpha\n')
    expect(await readFile(join(b.worktreePath, 'notes.txt'), 'utf8')).toBe('beta\n')
    expect(await readFile(join(a.worktreePath, 'tracked.txt'), 'utf8')).toBe('work in progress\n')
    await expect(access(join(a.worktreePath, 'scratch.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('base\n')
    expect(h.ctx.workingDirectory.get(first!.session)).toBe(a.worktreePath)
    const records = own(first!).map(pluginRecordOf).flatMap(record => record === undefined ? [] : [record.type])
    expect(records).toEqual(['plugin:loom/branch', 'plugin:loom/isolation'])
    const prompt = own(first!).findIndex(event => event.type === 'user/message' && event.data.source.kind === 'user')
    const recorded = own(first!).findIndex(event => pluginRecordOf(event)?.type === 'plugin:loom/isolation')
    expect(recorded).toBeLessThan(prompt)
  })

  it('refuses isolation before any fork when the Host cannot give each child a worktree', async () => {
    const root = await folder()
    await repository(root)
    await mkdir(join(root, 'sub'))
    const linked = join(root, 'linked')
    await git(root, 'worktree', 'add', '-b', 'linked', linked)
    const plain = await folder('dsh-loom-plain-')
    const h = await host({ workspaceRoot: root })
    const fork = vi.spyOn(h.ctx.sessionController, 'fork')
    const refused = async (from: Agent, reason: string): Promise<void> => {
      await expect(h.ctx.loom.branch(steer(from.id, ['write notes.txt: x'])))
        .rejects.toMatchObject({ code: 'loom/isolation-unavailable', details: { reason } })
    }
    await refused(await source(h, root, 'read-only'), 'read-only')
    await refused(await source(h, plain), 'no-repository')
    await refused(await source(h, join(root, 'sub'), 'workspace-write'), 'subdirectory')
    await refused(await source(h, linked, 'workspace-write'), 'linked-checkout')
    const homeless = await h.agents.create(SessionId('isolation-homeless'), { provider: 'mock', model: 'mock' })
    setSandboxMode(homeless.session, 'danger-full-access')
    homeless.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await homeless.whenIdle()
    await refused(homeless, 'no-repository')
    expect(fork).not.toHaveBeenCalled()

    const bare = await host({ workspaceRoot: root, worktree: false })
    const spy = vi.spyOn(bare.ctx.sessionController, 'fork')
    await expect(bare.ctx.loom.branch(steer((await source(bare, root)).id, ['write notes.txt: x'])))
      .rejects.toMatchObject({ code: 'loom/isolation-unavailable', details: { reason: 'service-unavailable' } })
    expect(spy).not.toHaveBeenCalled()
  })

  it('isolates from a subdirectory or a linked checkout without confinement, and follows the configured default', async () => {
    const root = await folder()
    await repository(root)
    await mkdir(join(root, 'sub'))
    const h = await host({ workspaceRoot: root, config: { defaultIsolation: 'worktree', worktreeBranchPrefix: 'try-' } })
    const nested = await source(h, join(root, 'sub'))
    const [child] = await settled(h, await h.ctx.loom.branch({ sessionId: nested.id, requestId: requestId(), kind: 'steer', afterTurn: 1, lines: ['write notes.txt: nested'] }))
    const record = isolationOf(child!)
    expect(record).toMatchObject({ repositoryRoot: root, branchName: `try-${child!.id}`, baseCommit: await git(root, 'rev-parse', 'HEAD') })
    expect(await readFile(join(record.worktreePath, 'notes.txt'), 'utf8')).toBe('nested\n')

    const [shared] = await settled(h, await h.ctx.loom.branch(steer(nested.id, ['ok'], { isolation: 'shared' })))
    expect(own(shared!).some(event => pluginRecordOf(event)?.type === 'plugin:loom/isolation')).toBe(false)
  })

  it('passes the confined-mode checks for a repository at the source folder and creates under the Session policy', async () => {
    const root = await folder()
    await repository(root)
    const h = await host({ workspaceRoot: root })
    const from = await source(h, root, 'workspace-write')
    const value = await h.ctx.loom.branch(steer(from.id, ['write notes.txt: x']))
    expect(value.children).toEqual([{ index: 0, state: 'failed', code: 'gateway/internal', message: expect.stringContaining('unexpected confinement') as string, sessionId: ANY_SESSION }])
  })

  it('fails a child whose worktree cannot be created, keeping its Session without records or prompt', async () => {
    const root = await folder()
    await repository(root)
    const h = await host({ workspaceRoot: root })
    const from = await source(h, root)
    vi.spyOn(h.ctx.worktrees, 'create').mockRejectedValueOnce(new Error('disk full'))
    const value = await h.ctx.loom.branch(steer(from.id, ['write notes.txt: x']))
    expect(value.children).toEqual([{ index: 0, state: 'failed', code: 'gateway/internal', message: 'disk full', sessionId: ANY_SESSION }])
    const failed = value.children[0]!
    const agent = h.ctx.agents.get(failed.state === 'failed' ? failed.sessionId! : SessionId('none'))!
    expect(own(agent).filter(event => pluginRecordOf(event) !== undefined || event.type === 'user/message')).toEqual([])
  })

  it('fails a child admitted after the worktree service unloaded', async () => {
    const root = await folder()
    await repository(root)
    const h = await host({ workspaceRoot: root, config: { maxConcurrentBranches: 1 } })
    const from = await source(h, root)
    h.adapter.held.add('pending')
    const fork = h.ctx.sessionController.fork.bind(h.ctx.sessionController)
    let unload: (() => Promise<void>) | undefined
    vi.spyOn(h.ctx.sessionController, 'fork').mockImplementation(async (request) => {
      const forked = await fork(request)
      await unload?.()
      return forked
    })
    const [fiber] = [...h.ctx.registry.get((await import('@deepseek-ai/dsh-experimental-worktree')).default)!.fibers]
    unload = async () => { unload = undefined; await fiber!.dispose() }
    const value = await h.ctx.loom.branch(steer(from.id, ['write notes.txt: x']))
    expect(value.children).toEqual([{
      index: 0, state: 'failed', code: 'loom/isolation-unavailable', message: 'the worktree service unloaded before the child was isolated', sessionId: ANY_SESSION,
    }])
  })
})

describe('apply and discard', () => {
  it('refuses a dirty source, applies a clean one byte for byte, refuses a conflict, and removes only its own worktree', async () => {
    const root = await folder()
    await repository(root)
    await writeFile(join(root, 'tracked.txt'), 'work in progress\n')
    await writeFile(join(root, 'scratch.txt'), 'untracked\n')
    const h = await host({ workspaceRoot: root })
    const from = await source(h, root)
    const [a, b, c] = await settled(h, await h.ctx.loom.branch(steer(from.id, ['write notes.txt: alpha', 'write notes.txt: beta', 'write fresh.txt: new file'])))
    const manual = join(await folder('dsh-loom-manual-'), 'checkout')
    await git(root, 'worktree', 'add', '-b', 'manual', manual)

    await expect(h.ctx.loom.apply({ sessionId: a!.id })).rejects.toMatchObject({ code: 'loom/apply-dirty', details: { paths: ['tracked.txt'] } })
    await access(isolationOf(a!).worktreePath)

    await git(root, 'commit', '-am', 'work in progress')
    const before = await Promise.all(['keep.bin', 'tracked.txt', 'scratch.txt'].map(name => readFile(join(root, name))))
    expect(await h.ctx.loom.apply({ sessionId: a!.id })).toEqual({ applied: [{ path: 'notes.txt' }] })
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('alpha\n')
    expect(await Promise.all(['keep.bin', 'tracked.txt', 'scratch.txt'].map(name => readFile(join(root, name))))).toEqual(before)
    expect(await git(root, 'status', '--porcelain')).toBe('M notes.txt\n?? scratch.txt')
    await expect(access(isolationOf(a!).worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git(root, 'branch', '--list', isolationOf(a!).branchName)).toBe('')
    expect(h.ctx.workingDirectory.get(a!.session)).toBe(root)
    expect(own(a!).map(pluginRecordOf).findLast(record => record !== undefined))
      .toMatchObject({ type: 'plugin:loom/isolation-end', data: { version: 1, reason: 'applied' } })

    await git(root, 'commit', '-am', 'alpha')
    await expect(h.ctx.loom.apply({ sessionId: b!.id })).rejects.toMatchObject({ code: 'loom/apply-conflict', details: { paths: ['notes.txt'] } })
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('alpha\n')
    expect(await h.ctx.loom.apply({ sessionId: c!.id })).toEqual({ applied: [{ path: 'fresh.txt' }] })
    expect(await readFile(join(root, 'fresh.txt'), 'utf8')).toBe('new file\n')

    await expect(h.ctx.loom.apply({ sessionId: a!.id })).rejects.toMatchObject({ code: 'loom/worktree-unavailable', details: { reason: 'removed' } })
    await expect(h.ctx.loom.discard({ sessionId: a!.id })).rejects.toMatchObject({ code: 'loom/worktree-unavailable', details: { reason: 'removed' } })
    const removed = isolationOf(b!)
    expect(await h.ctx.loom.discard({ sessionId: b!.id })).toEqual({ worktreePath: removed.worktreePath, branchName: removed.branchName })
    await expect(access(removed.worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(manual, 'notes.txt'), 'utf8')).toBe('base\n')
    expect(await git(root, 'branch', '--list', 'manual')).toBe('+ manual')
    expect(await git(root, 'worktree', 'list', '--porcelain')).toContain(`worktree ${manual}`)
  })

  it('applies a child without changes by removing its worktree', async () => {
    const root = await folder()
    await repository(root)
    const h = await host({ workspaceRoot: root })
    const [child] = await settled(h, await h.ctx.loom.branch(steer((await source(h, root)).id, ['ok'])))
    expect(await h.ctx.loom.apply({ sessionId: child!.id })).toEqual({ applied: [] })
    await expect(access(isolationOf(child!).worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['apply', 'discard'] as const)('queues waking input until %s releases the child checkout', async (action) => {
    const root = await folder()
    await repository(root)
    const h = await host({ workspaceRoot: root })
    const [child] = await settled(h, await h.ctx.loom.branch(steer((await source(h, root)).id, ['write notes.txt: revised'])))
    if (child === undefined) throw new Error('Missing isolated child')
    const entered = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    const remove = h.ctx.worktrees.remove.bind(h.ctx.worktrees)
    vi.spyOn(h.ctx.worktrees, 'remove').mockImplementation(async (...args) => {
      entered.resolve(undefined)
      await released.promise
      return remove(...args)
    })
    const pending = h.ctx.loom[action]({ sessionId: child.id })
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error('The operation skipped the held removal') })])
      const before = h.adapter.requests.length
      child.followup(createUserMessage({ content: [{ type: 'text', text: 'After checkout removal.' }], source: { kind: 'user' } }))
      expect(child.status).toBe('idle')
      expect(h.adapter.requests).toHaveLength(before)
    } finally { released.resolve(undefined) }
    await pending
    await child.whenIdle()
    const events = own(child)
    const end = events.findIndex(event => pluginRecordOf(event)?.type === 'plugin:loom/isolation-end')
    const prompt = events.findIndex(event => event.type === 'user/message' && event.data.content.some(block =>
      block.type === 'text' && block.text === 'After checkout removal.'))
    expect(end).toBeGreaterThan(-1)
    expect(prompt).toBeGreaterThan(end)
    await expect(access(isolationOf(child).worktreePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses worktree writes while another maintenance operation owns the child', async () => {
    const root = await folder()
    await repository(root)
    const h = await host({ workspaceRoot: root })
    const [child] = await settled(h, await h.ctx.loom.branch(steer((await source(h, root)).id, ['ok'])))
    if (child === undefined) throw new Error('Missing isolated child')
    const released = Promise.withResolvers<undefined>()
    const maintenance = child.runMaintenance(() => released.promise)
    try {
      await expect(h.ctx.loom.apply({ sessionId: child.id })).rejects.toMatchObject({ code: 'session/agent-busy' })
      await expect(h.ctx.loom.discard({ sessionId: child.id })).rejects.toMatchObject({ code: 'session/agent-busy' })
      await access(isolationOf(child).worktreePath)
    } finally { released.resolve(undefined); await maintenance }
  })

  it('refuses shared children, running children, missing worktrees, and oversized changes', async () => {
    const root = await folder()
    await repository(root)
    const h = await host({ workspaceRoot: root, config: { apply: { maxPatchBytes: 64 } } })
    const from = await source(h, root)
    const [shared] = await settled(h, await h.ctx.loom.branch(steer(from.id, ['ok'], { isolation: 'shared' })))
    await expect(h.ctx.loom.apply({ sessionId: shared!.id })).rejects.toMatchObject({ code: 'loom/apply-not-isolated', details: { sessionId: shared!.id } })
    await expect(h.ctx.loom.discard({ sessionId: shared!.id })).rejects.toMatchObject({ code: 'loom/worktree-unavailable', details: { reason: 'shared' } })
    await expect(h.ctx.loom.apply({ sessionId: SessionId('isolation-unknown') })).rejects.toMatchObject({ code: 'session/not-found' })

    const [large, running, gone] = await settled(h, await h.ctx.loom.branch(steer(from.id, [`write notes.txt: ${'x'.repeat(200)}`, 'ok', 'ok'])))
    await expect(h.ctx.loom.apply({ sessionId: large!.id })).rejects.toMatchObject({ code: 'loom/apply-too-large', details: { sessionId: large!.id, limit: 64 } })
    await access(isolationOf(large!).worktreePath)

    h.adapter.held.add(running!.id)
    running!.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(running!.status).toBe('running') })
    await expect(h.ctx.loom.apply({ sessionId: running!.id })).rejects.toMatchObject({ code: 'session/agent-busy' })
    await expect(h.ctx.loom.discard({ sessionId: running!.id })).rejects.toMatchObject({ code: 'session/agent-busy' })
    h.adapter.release(running!.id)
    await running!.whenIdle()

    const missing = isolationOf(gone!)
    await git(root, 'worktree', 'remove', '--force', missing.worktreePath)
    for (const call of [() => h.ctx.loom.apply({ sessionId: gone!.id }), () => h.ctx.loom.discard({ sessionId: gone!.id })]) {
      await expect(call()).rejects.toMatchObject({ code: 'loom/worktree-unavailable', details: { reason: 'missing' } })
    }
    expect(await git(root, 'branch', '--list', missing.branchName)).toBe(`  ${missing.branchName}`.trim())
  })

  it('reports a worktree it could not remove after an apply, and a discard that failed', async () => {
    const root = await folder()
    await repository(root)
    const h = await host({ workspaceRoot: root })
    const [first, second] = await settled(h, await h.ctx.loom.branch(steer((await source(h, root)).id, ['write notes.txt: alpha', 'ok'])))
    const remove = vi.spyOn(h.ctx.worktrees, 'remove').mockRejectedValueOnce(new Error('locked'))
    await expect(h.ctx.loom.apply({ sessionId: first!.id })).rejects.toMatchObject({
      code: 'loom/worktree-cleanup-failed',
      details: { sessionId: first!.id, worktreePath: isolationOf(first!).worktreePath, applied: ['notes.txt'] },
    })
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('alpha\n')
    remove.mockRejectedValueOnce(new Error('locked'))
    await expect(h.ctx.loom.discard({ sessionId: second!.id })).rejects.toThrow('locked')
    expect(await h.ctx.loom.discard({ sessionId: first!.id })).toMatchObject({ branchName: isolationOf(first!).branchName })
  })

  it('reports a branch whose Session cannot be resumed', async () => {
    const root = await folder()
    await repository(root)
    const h = await host({ workspaceRoot: root })
    const [child] = await settled(h, await h.ctx.loom.branch(steer((await source(h, root)).id, ['ok'])))
    const failure = new RemoteError('session/writer-held', 'another Host writes this Session', { sessionId: child!.id })
    vi.spyOn(h.ctx.sessionController, 'resolveAgent').mockResolvedValueOnce({ error: failure })
    await expect(h.ctx.loom.apply({ sessionId: child!.id })).rejects.toBe(failure)
  })

  it('needs the worktree service to apply or discard', async () => {
    const root = await folder()
    await repository(root)
    const h = await host({ workspaceRoot: root })
    const [child] = await settled(h, await h.ctx.loom.branch(steer((await source(h, root)).id, ['ok'])))
    const [fiber] = [...h.ctx.registry.get((await import('@deepseek-ai/dsh-experimental-worktree')).default)!.fibers]
    await fiber!.dispose()
    await expect(h.ctx.loom.discard({ sessionId: child!.id })).rejects.toMatchObject({ code: 'loom/isolation-unavailable', details: { reason: 'service-unavailable' } })
  })
})

// The local sandbox's POSIX runners are covered here; Windows ACL enforcement has its own native lane.
describe.skipIf(!sandboxUsable)('worktree isolation under a confined workspace-write policy', () => {
  it('creates, compares, applies, and discards with every Git command confined to the source folder', async () => {
    const root = await folder()
    await repository(root)
    const h = await host({ workspaceRoot: root, mode: 'workspace-write', sandbox: 'local' })
    const confine = vi.spyOn(h.ctx.sandbox, 'confine')
    const from = await source(h, root, 'workspace-write')
    const [kept, dropped] = await settled(h, await h.ctx.loom.branch(steer(from.id, ['write notes.txt: alpha', 'write notes.txt: beta'])))
    const rows = (await h.ctx.loom.compare({ sessionId: kept!.id }, SIGNAL)).rows
    expect(rows.map(row => row.diff?.files)).toEqual([[{ path: 'notes.txt', insertions: 1, deletions: 1 }], [{ path: 'notes.txt', insertions: 1, deletions: 1 }]])
    expect(await h.ctx.loom.apply({ sessionId: kept!.id })).toEqual({ applied: [{ path: 'notes.txt' }] })
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('alpha\n')
    await h.ctx.loom.discard({ sessionId: dropped!.id })
    expect(await git(root, 'worktree', 'list', '--porcelain')).not.toContain('.agents/worktrees')
    expect(confine.mock.calls.length).toBeGreaterThan(0)
    expect(confine.mock.calls.every(call => call[1].mode === 'workspace-write' && call[1].workspaceRoot === root)).toBe(true)
  })
})
