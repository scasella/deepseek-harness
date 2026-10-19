/** Compare table derivation: outcome groups, isolation reading, and priced cost, with no ranking. */
import { describe, expect, it } from 'vitest'
import { compareTable } from '../src/client/compare-table.ts'
import { compareRow as row } from './fixtures.client.ts'

const TESTS = { passed: 9, failed: 0, total: 9, ok: true, command: 'python -m unittest' }
const change = (path: string, insertions: number) => ({ files: [{ path, insertions, deletions: 0 }], insertions, deletions: 0, source: 'worktree' as const })

describe('compareTable', () => {
  it('groups the rows that report the same test outcome and says whether their changes differ', () => {
    const table = compareTable([
      row('a', { tests: TESTS, diff: change('x.py', 3) }),
      row('b', { tests: TESTS, diff: change('x.py', 3) }),
      row('c', { tests: { ...TESTS, passed: 8, total: 8 }, diff: change('y.py', 1) }),
      row('d', { tests: TESTS, diff: change('z.py', 9) }),
      row('e'),
    ], () => null, 'Untitled')
    expect(table.groups).toEqual([{ labels: ['title a', 'title b', 'title d'], diffsDiffer: true }])
    expect(table.rows.map(entry => entry.grouped)).toEqual([true, true, false, true, false])
  })

  it('reads identical changes as the same, and a row without a diff as different from one with a diff', () => {
    const same = compareTable([row('a', { tests: TESTS, diff: change('x', 1) }), row('b', { tests: TESTS, diff: change('x', 1) })], () => null, 'Untitled')
    expect(same.groups[0]?.diffsDiffer).toBe(false)
    const mixed = compareTable([row('a', { tests: TESTS }), row('b', { tests: TESTS, diff: change('x', 1) })], () => null, 'Untitled')
    expect(mixed.groups[0]?.diffsDiffer).toBe(true)
  })

  it('names rows by steering line when their titles do not tell them apart, cutting long labels', () => {
    const long = 'Go with the clamp  \n option and then write the regression test you suggested and run the whole suite twice'
    const table = compareTable([
      row('a', { title: 'Same', prompt: long, tests: TESTS }),
      row('b', { title: 'Same', prompt: '', tests: TESTS }),
    ], () => null, 'Untitled')
    expect(table.groups[0]?.labels[0]?.endsWith('…')).toBe(true)
    expect(Array.from(table.groups[0]?.labels[0] ?? '')).toHaveLength(48)
    expect(table.groups[0]?.labels[0]).toContain('Go with the clamp option and then')
    // An empty steering line falls back to the title.
    expect(table.groups[0]?.labels[1]).toBe('Same')
    const nameless = compareTable([row('a', { title: '', prompt: ' ', tests: TESTS }), row('b', { title: '', prompt: '', tests: TESTS })], () => null, 'Untitled')
    expect(nameless.groups[0]?.labels).toEqual(['Untitled', 'Untitled'])
  })

  it('reads the isolation of the rows, the marks they show, and whether any cost is priced', () => {
    const marks = new Map([['a', 'keep' as const]])
    const rows = [
      row('a', { isolation: 'worktree', own: { steps: 1, inputTokens: 1, cachedTokens: 0, outputTokens: 1, usd: { amount: 0.006, label: 'list price' } } }),
      row('b', { isolation: 'worktree' }),
    ]
    const table = compareTable(rows, entry => marks.get(entry.sessionId) ?? null, 'Untitled')
    expect(table.isolation).toBe('worktree')
    expect(table.priced).toBe(true)
    expect(table.rows.map(entry => entry.mark)).toEqual(['keep', null])
    expect(compareTable([row('a'), row('b', { isolation: 'worktree' })], () => null, 'Untitled').isolation).toBe('mixed')
    expect(compareTable([row('a')], () => null, 'Untitled')).toMatchObject({ isolation: 'shared', priced: false, groups: [] })
    expect(compareTable([], () => null, 'Untitled')).toMatchObject({ isolation: 'shared', rows: [] })
  })
})
