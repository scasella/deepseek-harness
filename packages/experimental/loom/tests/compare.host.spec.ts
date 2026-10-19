/**
 * `loom.compare`, `loom.diff`, and `loom.adopt` over real worktree and
 * shared-folder children: rows derived from each branch's own log, test
 * outcomes from command output text, diffs from Git or change summaries,
 * adoption that archives and never deletes, and Remote access per sibling.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { pluginRecordOf, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { RemoteError, type PeerId, type Principal, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LoomBranchRequest, LoomBranchRequestId, LoomBranchValue, LoomCompareRow, LoomSetId } from '../src/types.ts'
import { mountWorkspaceHost, removeAll, repository, scratch, type WorkspaceHost, type WorkspaceHostOptions } from './workspace-host.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller of the Loom compare and adopt methods. */
    'loom-compare-test-guest': { readonly kind: 'loom-compare-test-guest' }
  }
}

const SIGNAL = new AbortController().signal
const GUEST: Principal = { kind: 'loom-compare-test-guest' }
const hosts: WorkspaceHost[] = []
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const host of hosts.splice(0)) await host.ctx.fiber.dispose()
  await removeAll(directories.splice(0))
})

async function setup(options: Partial<WorkspaceHostOptions> = {}): Promise<{ h: WorkspaceHost; root: string; from: Agent }> {
  const root = await scratch('dsh-loom-compare-')
  directories.push(root)
  await repository(root)
  const h = await mountWorkspaceHost({ mode: 'danger-full-access', workspaceRoot: root, ...options })
  hosts.push(h)
  return { h, root, from: await source(h, root) }
}

let count = 0
function requestId(): LoomBranchRequestId {
  count += 1
  return brandString<LoomBranchRequestId>(`compare-${String(count)}`)
}

async function source(h: WorkspaceHost, cwd: string): Promise<Agent> {
  count += 1
  const agent = await h.agents.create(SessionId(`compare-source-${String(count)}`), { provider: 'mock', model: 'mock' }, { cwd })
  setSandboxMode(agent.session, 'danger-full-access')
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return agent
}

function steer(sessionId: SessionId, lines: readonly string[], isolation: 'shared' | 'worktree' = 'worktree'): LoomBranchRequest {
  return { sessionId, requestId: requestId(), kind: 'steer', afterTurn: 1, lines, isolation }
}

/** Every child's Agent once the whole set started and went idle; children that share a writable folder start one at a time. */
async function settled(h: WorkspaceHost, value: LoomBranchValue): Promise<Agent[]> {
  const agents: Agent[] = []
  for (const { index } of value.children) {
    const sessionId = await vi.waitFor(() => {
      const child = h.ctx.loom.setStatus({ setId: value.setId }).children[index]!
      if (child.state !== 'started') throw new Error(`child ${String(index)} is ${child.state}`)
      return child.sessionId!
    })
    const agent = h.ctx.agents.get(sessionId)!
    await agent.whenIdle()
    agents.push(agent)
  }
  return agents
}

function own(agent: Agent): SessionEvent[] {
  return agent.session.snapshotEvents().slice(agent.session.inheritedEventCount)
}

function asGuest(h: WorkspaceHost, method: string): Context {
  const invocation: RemoteInvocation = {
    request: { namespace: 'loom', method, args: {} },
    service: 'loom',
    peer: { id: 'loom-compare-peer' as PeerId, ctx: h.ctx, principal: GUEST, interactions: 'answer', signal: new AbortController().signal, dispose: async () => {} },
    signal: new AbortController().signal,
    uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
  }
  return h.ctx.extend({ invocation })
}

const USAGE = { steps: 2, inputTokens: 20, cachedTokens: 0 }
const ANY_NUMBER = expect.any(Number) as number

describe('compare and diff of worktree children', () => {
  it('derives each row from the branch’s own log, tests from command output text, and diffs from Git', async () => {
    const { h, from } = await setup()
    h.bash.set('pytest -q', 'collected 4 items\n\n========= 3 passed, 1 failed in 0.20s =========\n[exit code: 1]')
    const value = await h.ctx.loom.branch(steer(from.id, ['write notes.txt: alpha', 'bash pytest -q', 'write fresh.txt: new file']))
    const [a, b, c] = await settled(h, value)
    await h.ctx.loom.mark({ sessionId: a!.id, mark: 'keep' })

    const compared = await h.ctx.loom.compare({ sessionId: a!.id }, SIGNAL)
    const base = { title: '', kind: 'steer', isolation: 'worktree', worktreeEnded: false, running: false, adopted: false, wallMs: ANY_NUMBER }
    expect(compared).toEqual({
      parent: from.id,
      cutSeq: SessionSeq(a!.session.inheritedEventCount - 1),
      cutTurn: 1,
      rows: [
        {
          ...base, sessionId: a!.id, prompt: 'write notes.txt: alpha', mark: 'keep',
          diff: { files: [{ path: 'notes.txt', insertions: 1, deletions: 1 }], insertions: 1, deletions: 1, source: 'worktree' },
          own: { ...USAGE, outputTokens: 9 },
        },
        {
          ...base, sessionId: b!.id, prompt: 'bash pytest -q',
          tests: { passed: 3, failed: 1, total: 4, ok: false, command: 'pytest -q' },
          diff: { files: [], insertions: 0, deletions: 0, source: 'worktree' },
          own: { ...USAGE, outputTokens: 9 },
        },
        {
          ...base, sessionId: c!.id, prompt: 'write fresh.txt: new file',
          diff: { files: [{ path: 'fresh.txt', insertions: 1, deletions: 0 }], insertions: 1, deletions: 0, source: 'worktree' },
          own: { ...USAGE, outputTokens: 9 },
        },
      ],
    })
    expect(await h.ctx.loom.compare({ sessionId: from.id, setId: value.setId }, SIGNAL)).toEqual(compared)
    expect(await h.ctx.loom.compare({ sessionId: c!.id, setId: value.setId }, SIGNAL)).toEqual(compared)

    const diff = await h.ctx.loom.diff({ sessionId: a!.id }, SIGNAL)
    expect(diff.truncated).toBe(false)
    expect(diff.unified).toContain('diff --git a/notes.txt b/notes.txt')
    expect(diff.unified).toMatch(/^-base$/m)
    expect(diff.unified).toMatch(/^\+alpha$/m)
    expect(await h.ctx.loom.diff({ sessionId: a!.id, path: 'notes.txt' }, SIGNAL)).toEqual(diff)
    expect(await h.ctx.loom.diff({ sessionId: a!.id, path: 'fresh.txt' }, SIGNAL)).toEqual({ unified: '', truncated: false })
    const added = await h.ctx.loom.diff({ sessionId: c!.id }, SIGNAL)
    expect(added.unified).toContain('new file mode 100644')
    expect(added.unified).toMatch(/^\+new file$/m)
  })

  it('counts a binary change without lines', async () => {
    const { h, from } = await setup()
    const [child] = await settled(h, await h.ctx.loom.branch(steer(from.id, ['ok'])))
    await writeFile(join(h.ctx.workingDirectory.get(child!.session), 'keep.bin'), Buffer.from([0, 9, 9, 0]))
    expect((await h.ctx.loom.compare({ sessionId: child!.id }, SIGNAL)).rows[0]?.diff).toEqual({
      files: [{ path: 'keep.bin', insertions: 0, deletions: 0 }], insertions: 0, deletions: 0, source: 'worktree',
    })
  })

  it('leaves files out past diff.maxBytes and reports it', async () => {
    const { h, from } = await setup({ config: { diff: { maxBytes: 400 } } })
    const [child] = await settled(h, await h.ctx.loom.branch(steer(from.id, ['write fresh.txt: small'])))
    const worktree = h.ctx.workingDirectory.get(child!.session)
    await writeFile(join(worktree, 'notes.txt'), 'long line\n'.repeat(60))
    const diff = await h.ctx.loom.diff({ sessionId: child!.id }, SIGNAL)
    expect(diff.truncated).toBe(true)
    expect(diff.unified).toContain('fresh.txt')
    expect(diff.unified).not.toContain('notes.txt')
    expect(await h.ctx.loom.diff({ sessionId: child!.id, path: 'notes.txt' }, SIGNAL)).toEqual({ unified: '', truncated: true })
  })

  it('omits a diff it cannot read and reports why diff fails', async () => {
    const { h, root, from } = await setup()
    const [failing, aborted, gone, ended] = await settled(h, await h.ctx.loom.branch(steer(from.id, ['ok', 'ok', 'ok', 'ok'])))
    const warn = vi.spyOn(h.ctx.logger, 'warn')
    const git = vi.spyOn(h.ctx.worktrees, 'git')
    git.mockRejectedValueOnce(new Error('index locked'))
    const rows = (await h.ctx.loom.compare({ sessionId: failing!.id }, SIGNAL)).rows
    expect(rows.find(row => row.sessionId === failing!.id)?.diff).toBeUndefined()
    expect(rows.find(row => row.sessionId === failing!.id)?.worktreeEnded).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('index locked'))
    git.mockRejectedValueOnce('plain failure')
    await h.ctx.loom.compare({ sessionId: failing!.id }, SIGNAL)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('plain failure'))

    const controller = new AbortController()
    git.mockImplementationOnce(async () => {
      controller.abort()
      throw new Error('stopped')
    })
    await expect(h.ctx.loom.compare({ sessionId: aborted!.id }, controller.signal)).rejects.toThrow('stopped')
    await expect(h.ctx.loom.compare({ sessionId: aborted!.id }, controller.signal)).rejects.toMatchObject({ code: 'gateway/cancelled' })

    const worktree = h.ctx.workingDirectory.get(gone!.session)
    await h.ctx.worktrees.remove(gone!, { path: worktree, branch: `loom/${gone!.id}`, repositoryRoot: root })
    await h.ctx.loom.discard({ sessionId: ended!.id })
    const after = await h.ctx.loom.compare({ sessionId: gone!.id }, SIGNAL)
    for (const id of [gone!.id, ended!.id]) expect(after.rows.find(row => row.sessionId === id)?.diff).toBeUndefined()
    expect(after.rows.find(row => row.sessionId === gone!.id)?.worktreeEnded).toBe(false)
    expect(after.rows.find(row => row.sessionId === ended!.id)?.worktreeEnded).toBe(true)
    await expect(h.ctx.loom.diff({ sessionId: gone!.id }, SIGNAL)).rejects.toMatchObject({ code: 'loom/worktree-unavailable', details: { reason: 'missing' } })
    await expect(h.ctx.loom.diff({ sessionId: ended!.id }, SIGNAL)).rejects.toMatchObject({ code: 'loom/worktree-unavailable', details: { reason: 'removed' } })
  })
})

describe('compare and diff of shared children', () => {
  it('reads diffs from the change summaries of each branch’s own turns', async () => {
    const { h, from } = await setup({ changes: true })
    const [a, b, c] = await settled(h, await h.ctx.loom.branch(steer(from.id, ['write notes.txt: alpha', 'ok', 'write fresh.txt: x'], 'shared')))
    const { rows } = await h.ctx.loom.compare({ sessionId: b!.id }, SIGNAL)
    expect(rows.map(row => [row.sessionId, row.isolation, row.diff])).toEqual([
      [a!.id, 'shared', { files: [{ path: 'notes.txt', insertions: 1, deletions: 1 }], insertions: 1, deletions: 1, source: 'workspace-changes' }],
      [b!.id, 'shared', { files: [], insertions: 0, deletions: 0, source: 'workspace-changes' }],
      [c!.id, 'shared', { files: [{ path: 'fresh.txt', insertions: 1, deletions: 0 }], insertions: 1, deletions: 0, source: 'workspace-changes' }],
    ])
    const diff = await h.ctx.loom.diff({ sessionId: a!.id }, SIGNAL)
    expect(diff).toEqual({ unified: 'diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1,1 +1,1 @@\n-base\n+alpha\n', truncated: false })
    expect(await h.ctx.loom.diff({ sessionId: a!.id, path: 'other.txt' }, SIGNAL)).toEqual({ unified: '', truncated: false })
    expect(await h.ctx.loom.diff({ sessionId: b!.id }, SIGNAL)).toEqual({ unified: '', truncated: false })
    expect((await h.ctx.loom.diff({ sessionId: c!.id }, SIGNAL)).unified).toBe('diff --git a/fresh.txt b/fresh.txt\n--- /dev/null\n+++ b/fresh.txt\n@@ -1,0 +1,1 @@\n+x\n')

    const changes = h.ctx.workspaceChanges
    const display = { path: 'notes.txt', display: 'notes.txt' }
    vi.spyOn(changes, 'diff')
      .mockResolvedValueOnce({ kind: 'binary', ...display })
      .mockResolvedValueOnce({ kind: 'oversized', ...display })
      .mockResolvedValueOnce({ kind: 'text', ...display, before: true, after: false, hunks: [], coarse: false })
      .mockResolvedValueOnce(undefined)
    expect((await h.ctx.loom.diff({ sessionId: a!.id }, SIGNAL)).unified).toBe('diff --git a/notes.txt b/notes.txt\nBinary files differ\n')
    expect((await h.ctx.loom.diff({ sessionId: a!.id }, SIGNAL)).unified).toBe('diff --git a/notes.txt b/notes.txt\nFile too large to compare\n')
    expect((await h.ctx.loom.diff({ sessionId: a!.id }, SIGNAL)).unified).toBe('diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ /dev/null\n')
    await expect(h.ctx.loom.diff({ sessionId: a!.id }, SIGNAL)).rejects.toMatchObject({ code: 'loom/diff-unavailable', details: { sessionId: a!.id } })

    vi.spyOn(changes, 'summary').mockReturnValue(undefined)
    expect((await h.ctx.loom.compare({ sessionId: a!.id }, SIGNAL)).rows.find(row => row.sessionId === a!.id)?.diff).toBeUndefined()
    await expect(h.ctx.loom.diff({ sessionId: a!.id }, SIGNAL)).rejects.toMatchObject({ code: 'loom/diff-unavailable' })
  })

  it('sums a branch’s own turns per file', async () => {
    const { h, from } = await setup({ changes: true })
    const [child] = await settled(h, await h.ctx.loom.branch(steer(from.id, ['write notes.txt: alpha'], 'shared')))
    for (const text of ['write notes.txt: gamma', 'write zeta.txt: z']) {
      child!.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await child!.whenIdle()
    }
    expect((await h.ctx.loom.compare({ sessionId: child!.id }, SIGNAL)).rows[0]?.diff).toEqual({
      files: [{ path: 'notes.txt', insertions: 2, deletions: 2 }, { path: 'zeta.txt', insertions: 1, deletions: 0 }],
      insertions: 3,
      deletions: 2,
      source: 'workspace-changes',
    })
    const { unified } = await h.ctx.loom.diff({ sessionId: child!.id, path: 'notes.txt' }, SIGNAL)
    expect(unified.match(/^diff --git /gm)).toHaveLength(2)
  })

  it('leaves files out past diff.maxBytes', async () => {
    const { h, from } = await setup({ changes: true, config: { diff: { maxBytes: 60 } } })
    const [child] = await settled(h, await h.ctx.loom.branch(steer(from.id, ['write notes.txt: alpha'], 'shared')))
    expect(await h.ctx.loom.diff({ sessionId: child!.id }, SIGNAL)).toEqual({ unified: '', truncated: true })
  })

  it('has no shared diff without a changes service', async () => {
    const { h, from } = await setup()
    const [child] = await settled(h, await h.ctx.loom.branch(steer(from.id, ['ok'], 'shared')))
    expect((await h.ctx.loom.compare({ sessionId: child!.id }, SIGNAL)).rows[0]).not.toHaveProperty('diff')
    await expect(h.ctx.loom.diff({ sessionId: child!.id }, SIGNAL)).rejects.toMatchObject({ code: 'loom/diff-unavailable' })
  })
})

describe('compare scope', () => {
  it('lists plain forks at the cut, skips other cuts, hidden and deleted Sessions, and refuses a Session that is not a fork', async () => {
    const { h, from } = await setup()
    const value = await h.ctx.loom.branch(steer(from.id, ['ok', 'ok'], 'shared'))
    const [a, b] = await settled(h, value)
    const cut = SessionSeq(a!.session.inheritedEventCount - 1)
    const plain = await h.ctx.sessionController.fork({ sessionId: from.id, atSeq: cut })
    await h.ctx.sessionController.fork({ sessionId: from.id, atSeq: SessionSeq(0) })
    const hidden = await h.ctx.loom.branch(steer(from.id, ['ok'], 'shared'))
    const [secret] = await settled(h, hidden)

    const rows = (await h.ctx.loom.compare({ sessionId: a!.id }, SIGNAL)).rows
    expect(rows.map(row => row.sessionId)).toEqual([a!.id, b!.id, plain.sessionId, secret!.id])
    expect(rows[2]).toEqual({
      sessionId: plain.sessionId, title: '', prompt: '', kind: 'fork', isolation: 'shared', running: false,
      own: { steps: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 }, adopted: false,
    })

    const bindings: RemoteAccessBinding[] = [a!.id, b!.id, plain.sessionId].map(id => ({
      role: { name: `loom-compare-test:${id}`, resource: 'session', actions: ['loom/compare'] },
      resource: { kind: 'session', id },
    }))
    h.ctx.remoteAccess.registerPolicy('loom-compare-test-guest', { bindings: () => bindings })
    expect((await asGuest(h, 'compare').loom.compare({ sessionId: a!.id }, SIGNAL)).rows.map(row => row.sessionId)).toEqual([a!.id, b!.id, plain.sessionId])

    const list = h.ctx.sessionController.list.bind(h.ctx.sessionController)
    vi.spyOn(h.ctx.sessionController, 'list').mockImplementation(async (request, signal) => {
      const listed = await list(request, signal)
      return { items: listed.items.map(({ projections: _, ...item }) => item) }
    })
    const inspect = h.ctx.sessionController.inspect.bind(h.ctx.sessionController)
    let failing: SessionId | undefined
    vi.spyOn(h.ctx.sessionController, 'inspect').mockImplementation(async (sessionId, signal) => {
      if (sessionId === secret!.id) throw new RemoteError('session/not-found', 'deleted', { sessionId })
      if (sessionId === failing) throw new Error('disk failure')
      return inspect(sessionId, signal)
    })
    expect((await h.ctx.loom.compare({ sessionId: a!.id }, SIGNAL)).rows.map(row => row.sessionId)).toEqual([a!.id, b!.id, plain.sessionId])
    failing = b!.id
    await expect(h.ctx.loom.compare({ sessionId: a!.id }, SIGNAL)).rejects.toThrow('disk failure')
    failing = undefined

    await expect(h.ctx.loom.compare({ sessionId: from.id }, SIGNAL)).rejects.toMatchObject({ code: 'loom/not-a-fork', details: { sessionId: from.id } })
    await expect(h.ctx.loom.compare({ sessionId: from.id, setId: brandString<LoomSetId>('loomset-unknown') }, SIGNAL))
      .rejects.toMatchObject({ code: 'loom/set-not-found', details: { setId: 'loomset-unknown' } })
    await expect(h.ctx.loom.compare({ sessionId: SessionId('compare-unknown') }, SIGNAL)).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('reports no cut turn before the first turn ended, and no wall time without an own turn start', async () => {
    const { h, from } = await setup()
    const early = await h.ctx.sessionController.fork({ sessionId: from.id, atSeq: SessionSeq(0) })
    expect(await h.ctx.loom.compare({ sessionId: early.sessionId }, SIGNAL)).toEqual({
      parent: from.id, cutSeq: SessionSeq(0), rows: [expect.objectContaining({ sessionId: early.sessionId })],
    })
    const turnStart = from.session.snapshotEvents().find(event => event.type === 'turn/start')!.seq
    const midTurn = await h.ctx.sessionController.fork({ sessionId: from.id, atSeq: turnStart })
    const forked = h.ctx.agents.get(midTurn.sessionId)!
    expect(own(forked).some(event => event.type === 'turn/end')).toBe(true)
    expect((await h.ctx.loom.compare({ sessionId: midTurn.sessionId }, SIGNAL)).rows[0]).not.toHaveProperty('wallMs')
  })

  it('finds a set through a fork outside it, whose first own turn the set regenerated beside it', async () => {
    const { h, from } = await setup()
    const [fork] = await settled(h, await h.ctx.loom.branch(steer(from.id, ['ok'], 'shared')))
    const variants = await h.ctx.loom.branch({ sessionId: fork!.id, requestId: requestId(), kind: 'regenerate', turn: 2, count: 2 })
    const members = await settled(h, variants)
    const compared = await h.ctx.loom.compare({ sessionId: fork!.id, setId: variants.setId }, SIGNAL)
    expect(compared.parent).toBe(from.id)
    expect(compared.cutSeq).toBe(SessionSeq(fork!.session.inheritedEventCount - 1))
    expect(compared.rows.map(row => [row.sessionId, row.kind])).toEqual(members.map(member => [member.id, 'regenerate']))
    await expect(h.ctx.loom.compare({ sessionId: from.id, setId: brandString<LoomSetId>('loomset-missing') }, SIGNAL))
      .rejects.toMatchObject({ code: 'loom/set-not-found' })
  })

  it('fails loud when a sibling’s own usage cannot be read', async () => {
    const { h, from } = await setup()
    const [child] = await settled(h, await h.ctx.loom.branch(steer(from.id, ['ok'], 'shared')))
    vi.spyOn(h.ctx.sessionController, 'projections').mockResolvedValueOnce(null)
    await expect(h.ctx.loom.compare({ sessionId: child!.id }, SIGNAL)).rejects.toMatchObject({ code: 'gateway/internal' })
  })

  it('reports a running sibling', async () => {
    const { h, from } = await setup()
    const [child] = await settled(h, await h.ctx.loom.branch(steer(from.id, ['ok'], 'shared')))
    h.adapter.held.add(child!.id)
    child!.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(child!.status).toBe('running') })
    expect((await h.ctx.loom.compare({ sessionId: child!.id }, SIGNAL)).rows[0]).toMatchObject({ running: true })
    h.adapter.release(child!.id)
    await child!.whenIdle()
  })
})

function adoptRecords(agent: Agent): unknown[] {
  return own(agent).map(pluginRecordOf).filter(record => record?.type === 'plugin:loom/adopt').map(record => record?.data)
}

describe('adopt', () => {
  it('records the adoption in the adopted branch only and archives its set siblings without deleting them', async () => {
    const { h, from } = await setup({ config: { concurrentWritableBranches: true } })
    const value = await h.ctx.loom.branch(steer(from.id, ['ok', 'ok', 'ok'], 'shared'))
    const [a, b, c] = await settled(h, value)
    const plain = await h.ctx.sessionController.fork({ sessionId: from.id, atSeq: SessionSeq(a!.session.inheritedEventCount - 1) })

    expect(await h.ctx.loom.adopt({ sessionId: a!.id })).toEqual({ adopted: a!.id, archived: [b!.id, c!.id] })
    expect(h.archives.calls).toEqual([{ sessionId: b!.id, stopActivity: true }, { sessionId: c!.id, stopActivity: true }])
    expect(adoptRecords(a!)).toEqual([{ version: 1, setId: value.setId }])
    for (const sibling of [b!, c!]) expect(adoptRecords(sibling)).toEqual([])
    expect(own(from).some(event => pluginRecordOf(event)?.type === 'plugin:loom/adopt')).toBe(false)
    expect(h.ctx.sessionProjections.stateOf(a!.session, 'loomBranch')?.branch).toMatchObject({ adopted: true })
    const rows: readonly LoomCompareRow[] = (await h.ctx.loom.compare({ sessionId: a!.id }, SIGNAL)).rows
    expect(rows.map(row => [row.sessionId, row.adopted])).toEqual([[a!.id, true], [b!.id, false], [c!.id, false], [plain.sessionId, false]])
    await h.ctx.sessionController.inspect(b!.id)

    expect(await h.ctx.loom.adopt({ sessionId: a!.id })).toEqual({ adopted: a!.id, archived: [b!.id, c!.id] })
    expect(adoptRecords(a!)).toHaveLength(1)

    const forked = h.ctx.agents.get(plain.sessionId)!
    expect(await h.ctx.loom.adopt({ sessionId: plain.sessionId })).toEqual({ adopted: plain.sessionId, archived: [a!.id, b!.id, c!.id] })
    expect(adoptRecords(forked)).toEqual([{ version: 1 }])
  })

  it('reports a partial adoption and completes on retry', async () => {
    const { h, from } = await setup({ config: { concurrentWritableBranches: true } })
    const [a, b, c] = await settled(h, await h.ctx.loom.branch(steer(from.id, ['ok', 'ok', 'ok'], 'shared')))
    h.archives.fail = c!.id
    await expect(h.ctx.loom.adopt({ sessionId: a!.id })).rejects.toMatchObject({
      code: 'loom/adopt-incomplete',
      details: { sessionId: a!.id, archived: [b!.id], remaining: [c!.id] },
    })
    delete h.archives.fail
    expect(await h.ctx.loom.adopt({ sessionId: a!.id })).toEqual({ adopted: a!.id, archived: [b!.id, c!.id] })
    expect(adoptRecords(a!)).toHaveLength(1)
  })

  it('requires adopt access on every sibling before any write', async () => {
    const { h, from } = await setup({ config: { concurrentWritableBranches: true } })
    const [a, b] = await settled(h, await h.ctx.loom.branch(steer(from.id, ['ok', 'ok'], 'shared')))
    const bindings: RemoteAccessBinding[] = [{
      role: { name: 'loom-compare-test:adopt', resource: 'session', actions: ['loom/adopt'] },
      resource: { kind: 'session', id: a!.id },
    }]
    h.ctx.remoteAccess.registerPolicy('loom-compare-test-guest', { bindings: () => bindings })
    await expect(asGuest(h, 'adopt').loom.adopt({ sessionId: a!.id }))
      .rejects.toMatchObject({ code: 'remote-access/denied', details: { action: 'loom/adopt', reason: 'no-allow' } })
    expect(adoptRecords(a!)).toEqual([])
    expect(h.archives.calls).toEqual([])
    bindings.push({
      role: { name: 'loom-compare-test:adopt-sibling', resource: 'session', actions: ['loom/adopt'] },
      resource: { kind: 'session', id: b!.id },
    })
    expect(await asGuest(h, 'adopt').loom.adopt({ sessionId: a!.id })).toEqual({ adopted: a!.id, archived: [b!.id] })
  })

  it('refuses a Session that is not a fork', async () => {
    const { h, from } = await setup()
    await expect(h.ctx.loom.adopt({ sessionId: from.id })).rejects.toMatchObject({ code: 'loom/not-a-fork' })
    expect(h.archives.calls).toEqual([])
  })
})

describe('workspace operations lifetime', () => {
  it('waits for pending operations when the Loom service unloads and refuses later ones', async () => {
    const { h, from } = await setup()
    const [child] = await settled(h, await h.ctx.loom.branch(steer(from.id, ['ok'], 'shared')))
    const loom = h.ctx.loom
    const release = Promise.withResolvers<undefined>()
    const projections = h.ctx.sessionController.projections.bind(h.ctx.sessionController)
    const entered = Promise.withResolvers<AbortSignal>()
    vi.spyOn(h.ctx.sessionController, 'projections').mockImplementation(async (request, signal) => {
      entered.resolve(signal)
      await release.promise
      return projections(request, signal)
    })
    const pending = loom.compare({ sessionId: child!.id }, SIGNAL)
    const outcome = expect(pending).rejects.toMatchObject({ code: 'gateway/cancelled' })
    const signal = await entered.promise
    const aborted = new Promise<'aborted'>((resolve) => { signal.addEventListener('abort', () => { resolve('aborted') }, { once: true }) })
    let unloaded = false
    const disposal = h.loom.dispose().then(() => { unloaded = true })
    expect(await Promise.race([aborted, disposal.then(() => 'disposed' as const)])).toBe('aborted')
    expect(unloaded).toBe(false)
    release.resolve(undefined)
    await outcome
    await disposal
    expect(unloaded).toBe(true)
    await expect(loom.compare({ sessionId: child!.id }, SIGNAL)).rejects.toMatchObject({ code: 'gateway/cancelled' })
  })
})

it('keeps a branch file it never touched byte-identical in the source folder', async () => {
  const { h, root, from } = await setup()
  const before = await readFile(join(root, 'keep.bin'))
  const [child] = await settled(h, await h.ctx.loom.branch(steer(from.id, ['write notes.txt: alpha'])))
  await h.ctx.loom.apply({ sessionId: child!.id })
  expect(await readFile(join(root, 'keep.bin'))).toEqual(before)
})
