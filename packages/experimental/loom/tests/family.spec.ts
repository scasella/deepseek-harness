/** Fork families come from list rows: fork links only, highest listed ancestor first, siblings in creation order. */
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { forkFamily, loomSessionNode, type LoomFamilyRow } from '../src/family.ts'

function row(id: string, updatedAt: number, extra: Partial<LoomFamilyRow> = {}): LoomFamilyRow {
  return { sessionId: SessionId(id), updatedAt, running: false, blank: false, ...extra }
}

const ROOT = SessionId('root')
const A = SessionId('a')
const B = SessionId('b')
const C = SessionId('c')

describe('forkFamily', () => {
  it('returns a single root node for a Session without forks', () => {
    expect(forkFamily([row('root', 1, { running: true, blank: true })], ROOT)).toEqual({
      rootId: loomSessionNode(ROOT),
      focusId: loomSessionNode(ROOT),
      nodes: [{ id: 'root', sessionId: ROOT, depth: 0, updatedAt: 1, running: true, blank: true }],
    })
  })

  it('climbs to the highest listed ancestor and lists descendants depth-first by creation, then id', () => {
    const family = forkFamily([
      row('c', 5, { forkParentId: A, createdAt: 40 }),
      row('b', 9, { forkParentId: ROOT, createdAt: 30 }),
      row('a', 3, { forkParentId: ROOT, createdAt: 20 }),
      row('root', 1),
      row('d', 2, { forkParentId: ROOT, createdAt: 20 }),
      row('e', 1, { forkParentId: ROOT }),
      row('unrelated', 9),
    ], C)
    expect(family?.rootId).toBe('root')
    expect(family?.focusId).toBe('c')
    expect(family?.nodes.map(node => [node.sessionId, node.parentId, node.depth, node.createdAt])).toEqual([
      ['root', undefined, 0, undefined],
      ['a', 'root', 1, 20],
      ['c', 'a', 2, 40],
      ['d', 'root', 1, 20],
      ['b', 'root', 1, 30],
      ['e', 'root', 1, undefined],
    ])
  })

  it('stops at an unlisted parent and at a repeated Session', () => {
    expect(forkFamily([row('a', 1, { forkParentId: SessionId('hidden') }), row('b', 2, { forkParentId: A })], B)?.rootId)
      .toBe('a')
    const cycle = forkFamily([row('a', 1, { forkParentId: B }), row('b', 2, { forkParentId: A })], A)
    expect(cycle?.rootId).toBe('b')
    expect(cycle?.nodes.map(node => node.sessionId)).toEqual(['b', 'a'])
  })

  it('places a Session listed twice once', () => {
    const family = forkFamily([row('root', 1), row('a', 2, { forkParentId: ROOT }), row('a', 2, { forkParentId: ROOT })], ROOT)
    expect(family?.nodes.map(node => node.sessionId)).toEqual(['root', 'a'])
  })

  it('returns undefined for an unlisted Session', () => {
    expect(forkFamily([row('root', 1)], A)).toBeUndefined()
  })

  it('keeps the previous family and each unchanged node reference', () => {
    const rows = [row('root', 1), row('a', 2, { forkParentId: ROOT, createdAt: 5 }), row('b', 3, { forkParentId: ROOT, createdAt: 6 })]
    const first = forkFamily(rows, A)!
    expect(forkFamily([...rows], A, first)).toBe(first)
    const running = forkFamily([rows[0]!, rows[1]!, { ...rows[2]!, running: true }], A, first)!
    expect(running).not.toBe(first)
    expect(running.nodes.slice(0, 2)).toEqual(first.nodes.slice(0, 2))
    expect(running.nodes[0]).toBe(first.nodes[0])
    expect(running.nodes[1]).toBe(first.nodes[1])
    expect(running.nodes[2]?.running).toBe(true)
    expect(forkFamily(rows, B, first)?.focusId).toBe('b')
    expect(forkFamily(rows.slice(0, 2), A, first)?.nodes).toHaveLength(2)
  })
})
