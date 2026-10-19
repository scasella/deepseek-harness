/** Pending and completed card titles of the autoloom tools. */
import { describe, expect, it } from 'vitest'
import * as presentation from '../src/presentation.ts'

const ok = { content: [], isError: false }
const failed = { content: [{ type: 'text' as const, text: 'Error: refused' }], isError: true }

describe('autoloom presenters', () => {
  it('title expansions by target, count, and turn, with the lines as input', () => {
    const lines = { sessionId: 'session-0123456789abcdef', afterTurn: 2, lines: ['a', 'b'] }
    expect(presentation.presentExpandCall(lines)).toEqual({ card: 'generic', title: 'Branch session-0123… 2 ways after turn 2', kind: 'other', rawInput: ['a', 'b'] })
    expect(presentation.presentExpandCall({ sessionId: 'story', afterTurn: 0, count: 1 })).toEqual({ card: 'generic', title: 'Branch story 1 way after turn 0', kind: 'other' })
    expect(presentation.presentExpandCall({ sessionId: 'story', afterTurn: 0 })).toMatchObject({ title: 'Branch story 0 ways after turn 0' })
    expect(presentation.presentExpandCall({ afterTurn: 1, count: 2 })).toMatchObject({ title: 'Branch this Session 2 ways after turn 1' })
    expect(presentation.presentExpandResult(lines, ok)).toEqual({ card: 'generic', title: 'Branched session-0123… 2 ways after turn 2' })
    expect(presentation.presentExpandResult(lines, failed)).toBeUndefined()
  })

  it('title waits, reads, culls, and keeps', () => {
    const child = { sessionId: 'child' }
    expect(presentation.presentWaitCall({ setId: 'loomset-1' })).toEqual({ card: 'generic', title: 'Wait for branch set loomset-1', kind: 'other' })
    expect(presentation.presentReadCall(child)).toEqual({ card: 'generic', title: 'Read branch child', kind: 'read' })
    expect(presentation.presentCullCall(child)).toEqual({ card: 'generic', title: 'Stop and archive branch child', kind: 'delete' })
    expect(presentation.presentCullResult(child, ok)).toEqual({ card: 'generic', title: 'Archived branch child' })
    expect(presentation.presentCullResult(child, failed)).toBeUndefined()
    expect(presentation.presentKeepCall(child)).toEqual({ card: 'generic', title: 'Keep branch child', kind: 'other' })
    expect(presentation.presentKeepResult(child, ok)).toEqual({ card: 'generic', title: 'Kept branch child' })
    expect(presentation.presentKeepResult(child, failed)).toBeUndefined()
  })
})
