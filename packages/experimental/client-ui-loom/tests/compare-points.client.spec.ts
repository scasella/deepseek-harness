/** Branch points of a family for Compare: the cuts at which Sessions were forked, and the point a Session opens on. */
import { describe, expect, it } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { branchPointId, branchPoints, defaultPoint } from '../src/client/compare-points.ts'
import { entry, familyIn, listOf } from './fixtures.client.ts'

const ROOT = SessionId('root')
const MEMBERS = [
  { id: 'root', outline: [entry(1, 0), entry(2, 12), entry(3, 30)] },
  { id: 'late', parent: 'root', cutSeq: 25, cutTurn: 2, createdAt: 5 },
  { id: 'a', parent: 'root', cutSeq: 10, cutTurn: 1, createdAt: 1 },
  { id: 'b', parent: 'root', cutSeq: 10, cutTurn: 1, createdAt: 2 },
  { id: 'inside', parent: 'root', cutSeq: 15, createdAt: 3 },
  { id: 'a1', parent: 'a', cutSeq: 40, cutTurn: 3, createdAt: 4 },
  { id: 'nolineage', parent: 'root', createdAt: 6 },
]

describe('branch points', () => {
  const list = listOf(MEMBERS)
  const family = familyIn(list, 'root')

  it('lists each parent’s cuts in seq order with the children forked there in family order', () => {
    const points = branchPoints(family, list)
    expect(points.map(point => [point.id, point.children])).toEqual([
      ['p:root:10', ['a', 'b']],
      ['p:root:15', ['inside']],
      ['p:root:25', ['late']],
      ['p:a:40', ['a1']],
    ])
    expect(points[0]).toMatchObject({ parentSessionId: ROOT, cutSeq: SessionSeq(10), cutTurn: 1, openedTurn: 1 })
    // A cut inside a turn has no ended turn, and names the turn the parent's outline says it interrupted.
    expect(points[1]).toMatchObject({ openedTurn: 2 })
    expect(points[1]).not.toHaveProperty('cutTurn')
    expect(points[3]).not.toHaveProperty('openedTurn')
    expect(branchPointId(ROOT, SessionSeq(10))).toBe('p:root:10')
  })

  it('opens on the cut the Session was forked at, else its own latest cut, else the first point', () => {
    const points = branchPoints(family, list)
    expect(defaultPoint(points, list, SessionId('b'))?.id).toBe('p:root:10')
    expect(defaultPoint(points, list, ROOT)?.id).toBe('p:root:25')
    expect(defaultPoint(points, list, SessionId('nolineage'))?.id).toBe('p:root:10')
    expect(defaultPoint([], list, ROOT)).toBeUndefined()
    // A fork whose own cut has no point (its row is missing) falls back like a Session with no cut.
    expect(defaultPoint(points.filter(point => point.id !== 'p:a:40'), list, SessionId('a1'))?.id).toBe('p:root:10')
  })
})
