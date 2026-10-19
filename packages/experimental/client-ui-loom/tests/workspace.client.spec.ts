/** Adopt, apply, and discard: outcomes with their typed failures, and the projection read after an adoption. */
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createLoomWorkspace, type LoomWorkspaceInputs } from '../src/client/workspace.ts'

const A = SessionId('a')
const B = SessionId('b')

function ok<V>(value: V): RemoteResult<V> {
  return { ok: true, value }
}

function inputs() {
  return {
    adopt: vi.fn<LoomWorkspaceInputs['adopt']>(async () => ok({ adopted: A, archived: [B] })),
    apply: vi.fn<LoomWorkspaceInputs['apply']>(async () => ok({ applied: [{ path: 'x.py' }] })),
    discard: vi.fn<LoomWorkspaceInputs['discard']>(async () => ok({ worktreePath: '/w', branchName: 'loom/a' })),
    refreshProjection: vi.fn<LoomWorkspaceInputs['refreshProjection']>(async () => {}),
  }
}

describe('Loom workspace verbs', () => {
  it('adopts a branch and reads its projections again so the adopted marker arrives', async () => {
    const calls = inputs()
    const workspace = createLoomWorkspace(calls)
    await expect(workspace.adopt(A)).resolves.toEqual({ ok: true, value: { adopted: A, archived: [B] } })
    expect(calls.adopt).toHaveBeenCalledWith({ sessionId: A })
    expect(calls.refreshProjection).toHaveBeenCalledWith(A)
  })

  it('reports a refused adoption and reads nothing', async () => {
    const calls = inputs()
    calls.adopt.mockResolvedValueOnce({ ok: false, error: new RemoteError('loom/not-a-fork', 'x', { sessionId: A }) })
    const outcome = await createLoomWorkspace(calls).adopt(A)
    expect(outcome).toEqual({ ok: false, failure: { code: 'loom/not-a-fork', unknownOutcome: false } })
    expect(calls.refreshProjection).not.toHaveBeenCalled()
  })

  it('reads the branch again when the Host adopted it but archived only some siblings, so the marker still arrives', async () => {
    const calls = inputs()
    calls.adopt.mockResolvedValueOnce({ ok: false, error: new RemoteError('loom/adopt-incomplete', 'x', { sessionId: A, archived: [], remaining: [B] }) })
    const outcome = await createLoomWorkspace(calls).adopt(A)
    expect(outcome).toEqual({ ok: false, failure: { code: 'loom/adopt-incomplete', remaining: 1, unknownOutcome: false } })
    expect(calls.refreshProjection).toHaveBeenCalledWith(A)
  })

  it('keeps the adoption when the projection read fails, and skips the read after disposal', async () => {
    const calls = inputs()
    calls.refreshProjection.mockRejectedValue(new Error('read failed'))
    const workspace = createLoomWorkspace(calls)
    await expect(workspace.adopt(A)).resolves.toMatchObject({ ok: true })
    await Promise.resolve()
    workspace.dispose()
    await expect(workspace.adopt(B)).resolves.toMatchObject({ ok: true })
    expect(calls.adopt).toHaveBeenCalledTimes(2)
  })

  it('applies a worktree change and names what a dirty or conflicting folder, or a failed cleanup, reports', async () => {
    const calls = inputs()
    const workspace = createLoomWorkspace(calls)
    await expect(workspace.apply(A)).resolves.toEqual({ ok: true, value: { applied: [{ path: 'x.py' }] } })
    expect(calls.apply).toHaveBeenCalledWith({ sessionId: A })
    const failures = [
      new RemoteError('loom/apply-dirty', 'x', { paths: ['a'] }),
      new RemoteError('loom/apply-conflict', 'x', { paths: ['a', 'b'] }),
      new RemoteError('loom/apply-not-isolated', 'x', { sessionId: A }),
      new RemoteError('loom/worktree-cleanup-failed', 'x', { sessionId: A, worktreePath: '/w', applied: ['a'] }),
    ]
    const codes = []
    for (const error of failures) {
      calls.apply.mockResolvedValueOnce({ ok: false, error })
      const outcome = await workspace.apply(A)
      codes.push(outcome.ok ? 'ok' : outcome.failure.code)
    }
    expect(codes).toEqual(['loom/apply-dirty', 'loom/apply-conflict', 'loom/apply-not-isolated', 'loom/worktree-cleanup-failed'])
  })

  it('discards a worktree and reads a call that rejected as an unavailable Loom', async () => {
    const calls = inputs()
    const workspace = createLoomWorkspace(calls)
    await expect(workspace.discard(A)).resolves.toEqual({ ok: true, value: { worktreePath: '/w', branchName: 'loom/a' } })
    expect(calls.discard).toHaveBeenCalledWith({ sessionId: A })
    calls.discard.mockRejectedValueOnce(new Error('unmounted'))
    await expect(workspace.discard(A)).resolves.toEqual({ ok: false, failure: { code: 'loom/unavailable', unknownOutcome: false } })
  })
})
