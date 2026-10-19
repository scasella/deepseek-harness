/** Own Loom records of a Session, and the Git output parsers of apply. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { ownLoomRecords } from '../src/records.ts'
import type { LoomSetId } from '../src/types.ts'
import { byPath, changedTrackedPaths, compareText, conflictPaths } from '../src/worktree-git.ts'

const BASE = 'a'.repeat(40)
const ISOLATION = { version: 1, baseCommit: BASE, worktreePath: '/repo/.agents/worktrees/loom/x', branchName: 'loom/x', repositoryRoot: '/repo' }
const BRANCH = { version: 1, setId: 'set-1', sourceSessionId: 'source', atSeq: 0, kind: 'steer', index: 0 }

function records(...entries: readonly [string, unknown][]): SessionEvent[] {
  return entries.map(([type, data], seq) => ({ type, data, seq: SessionSeq(seq), time: seq, ignorable: true }) as SessionEvent)
}

describe('own Loom records', () => {
  it('keeps the first valid own branch and isolation records and reads ends and adoptions after them', () => {
    const events = records(
      ['plugin:loom/isolation', ISOLATION],
      ['plugin:loom/isolation-end', { version: 1, reason: 'applied' }],
      ['plugin:loom/adopt', { version: 1 }],
      ['plugin:loom/isolation-end', { version: 1, reason: 'discarded' }],
      ['plugin:loom/branch', { ...BRANCH, index: -1 }],
      ['plugin:loom/branch', BRANCH],
      ['plugin:loom/isolation', { ...ISOLATION, baseCommit: 'HEAD' }],
      ['plugin:loom/isolation', ISOLATION],
      ['plugin:loom/branch', { ...BRANCH, index: 1 }],
      ['plugin:loom/mark', { version: 1, mark: 'keep' }],
      ['turn/start', { turn: 1 }],
    )
    expect(ownLoomRecords(events, 4)).toEqual({
      branch: { ...BRANCH, setId: brandString<LoomSetId>('set-1'), sourceSessionId: SessionId('source'), atSeq: SessionSeq(0) },
      isolation: ISOLATION,
      isolationEnded: false,
      adopted: false,
    })
    const ended = records(['plugin:loom/isolation', ISOLATION], ['plugin:loom/isolation-end', { version: 2 }], ['plugin:loom/isolation-end', { version: 1, reason: 'discarded' }])
    expect(ownLoomRecords(ended, 0)).toMatchObject({ isolationEnded: true })
    const adopted = records(['plugin:loom/adopt', { version: 1, setId: 1 }], ['plugin:loom/adopt', { version: 1, setId: 'set-1' }])
    expect(ownLoomRecords(adopted, 0)).toEqual({ isolationEnded: false, adopted: true })
  })
})

describe('apply output parsers', () => {
  it('lists changed tracked paths, taking the new path of a rename or copy', () => {
    expect(changedTrackedPaths('')).toEqual([])
    expect(changedTrackedPaths(' M zeta.txt\0R  new name.txt\0old name.txt\0 C copy.txt\0source.txt\0A  added.txt\0')).toEqual([
      'added.txt', 'copy.txt', 'new name.txt', 'zeta.txt',
    ])
  })

  it('names the paths git apply refused, once each', () => {
    const stderr = [
      'error: patch failed: notes.txt:1',
      'error: notes.txt: patch does not apply',
      'error: fresh.txt: already exists in working directory',
      'error: gone.txt: No such file or directory',
      'error: unrelated failure',
      '',
    ].join('\n')
    expect(conflictPaths(stderr)).toEqual(['fresh.txt', 'gone.txt', 'notes.txt'])
    expect(conflictPaths('fatal: corrupt patch at line 3\n')).toEqual([])
  })
})

describe('path order', () => {
  it('orders by code unit, independent of locale', () => {
    expect([compareText('a', 'b'), compareText('b', 'a'), compareText('a', 'a'), compareText('Z', 'a')]).toEqual([-1, 1, 0, -1])
    expect([{ path: 'b' }, { path: 'a' }].sort(byPath)).toEqual([{ path: 'a' }, { path: 'b' }])
  })
})
