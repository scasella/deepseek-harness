// @vitest-environment jsdom
/** Autoloom cards use raw durable content, preserve unknown output, and expose branch links. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AutoloomCard, autoloomCardValue, type AutoloomCardProps } from '../src/client/AutoloomCard.tsx'
import { tEn } from './fixtures.client.ts'

afterEach(cleanup)
const payload = { children: [{ index: 0, state: 'running', sessionId: 'a', ownTokens: 4, stoppedByBudget: true }, { index: 1, state: 'failed', error: 'permission-refused: tool denied' }], budget: { branchesLeft: 2, ownTokensLeft: 10, maxDepth: 3, usdLeft: .03 }, sessionId: 'root', output: 'answer', ownTokens: 4, timedOut: true, archived: true, stoppedByBudget: true, mark: 'keep' }
function props(raw: string, extra: Partial<AutoloomCardProps> = {}): AutoloomCardProps { return { toolName: 'loom_expand', phase: 'result', block: { content: [{ type: 'text', text: raw }, { type: 'image', data: 'x', mimeType: 'image/png' }], isError: false }, useDisclosure: () => ({ expanded: true, toggle: vi.fn() }), openSession: vi.fn(), t: tEn, ...extra } as AutoloomCardProps }
describe('autoloom presentation', () => {
  it('decodes known result facts and falls back for malformed or foreign content', () => {
    for (const raw of ['invalid', 'null', '[]', '{"other":1}', '{"children":[null]}', '{"children":"bad"}', '{"children":[{"index":0,"state":"foreign"}]}', '{"children":[{"state":"running"}]}']) expect(autoloomCardValue(raw)).toBeUndefined()
    expect(autoloomCardValue(JSON.stringify(payload))).toMatchObject({
      children: payload.children, kept: true, budget: payload.budget, output: payload.output,
    })
    expect(autoloomCardValue('{"children":[{"index":0,"state":"idle"}],"budget":{}}')).toMatchObject({ children: [{ index: 0, state: 'idle', stoppedByBudget: false }] })
    expect(autoloomCardValue('{"budget":{"branchesLeft":1,"ownTokensLeft":2,"maxDepth":3}}')?.budget).toEqual({ branchesLeft: 1, ownTokensLeft: 2, maxDepth: 3 })
  })
  it('shows budgets, child outcomes and links from raw results rather than tool meta', () => {
    const p = props(JSON.stringify(payload))
    render(<AutoloomCard {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Branch 1' })); expect(p.openSession).toHaveBeenCalledWith('a')
    fireEvent.click(screen.getByRole('button', { name: 'Open branch' })); expect(p.openSession).toHaveBeenCalledWith('root')
    expect(screen.getByText(/list price/)).toBeTruthy()
    expect(screen.getByText('Marked Keep')).toBeTruthy()
    expect(screen.getByText('answer')).toBeTruthy()
    expect(screen.getByText('permission-refused: tool denied')).toBeTruthy()
    expect(screen.getByText('Raw result details')).toBeTruthy()
  })
  it('retains failed output and a pending label at earlier phases for every tool', () => {
    const b = render(<AutoloomCard {...props('failure', { block: { content: [{ type: 'text', text: 'failure' }], isError: true } as never })} />)
    expect(screen.getByText('failure')).toBeTruthy()
    for (const toolName of ['loom_wait', 'loom_read', 'loom_cull', 'loom_keep', 'foreign']) {
      b.rerender(<AutoloomCard {...props('', { toolName, phase: 'call' } as never)} />)
      expect(screen.getByText('Waiting for the result')).toBeTruthy()
    }
    b.rerender(<AutoloomCard {...props('not-json')} />); expect(screen.getByText('not-json')).toBeTruthy()
    b.rerender(<AutoloomCard {...props('{}', { useDisclosure: () => ({ expanded: false, toggle: vi.fn() }) } as never)} />)
    expect(screen.queryByText('{}')).toBeNull()
    expect(screen.getByText('Finished')).toBeTruthy()
  })
})
