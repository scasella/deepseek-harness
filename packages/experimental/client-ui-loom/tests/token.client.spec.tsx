// @vitest-environment jsdom
/** Token inspection requires captured matching answer text; probability is also written. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TokenText, probabilityPercent } from '../src/client/TokenText.tsx'
import { ProbePanel } from '../src/client/ProbePanel.tsx'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LoomNodeId, LoomProbeNode } from '@deepseek-ai/dsh-experimental-loom/types'
import { tEn } from './fixtures.client.ts'

afterEach(cleanup)
const probs = { tokens: ['The', ' cat', ' sat', '.'], logprobs: [Math.log(.9), Math.log(.2), Math.log(.01), null], top: [[{ token: 'A', logprob: Math.log(.1) }], [], [], []] }
describe('captured answer tokens', () => {
  it('leaves missing, mismatched, and unknown probabilities plain', () => {
    const b = render(<TokenText text="text" t={tEn} />)
    expect(screen.queryByRole('button')).toBeNull()
    b.rerender(<TokenText text="mismatch" logprobs={probs} t={tEn} />)
    expect(screen.queryByRole('button')).toBeNull()
    b.rerender(<TokenText text="unknown" logprobs={{ tokens: ['unknown'], logprobs: [], top: [] }} t={tEn} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(probabilityPercent(Math.log(.001))).toBe('0.1')
  })
  it('shows conditional probabilities and alternatives without allowing a Chat prefill', () => {
    render(<TokenText text="The cat sat." logprobs={probs} t={tEn} />)
    expect(screen.getAllByRole('button').length).toBe(3)
    fireEvent.click(screen.getByRole('button', { name: /The.*90/ }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText(/A.*10/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close probabilities' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /sat.*1/ }))
    expect(screen.getByRole('dialog').textContent).toContain('1%')
  })
  it('retains an open inspector safely if a later projection loses one probability', () => {
    const b = render(<TokenText text="The cat sat." logprobs={probs} t={tEn} />)
    fireEvent.click(screen.getByRole('button', { name: /The.*90/ }))
    b.rerender(<TokenText text="The cat sat." logprobs={{ ...probs, logprobs: [null] }} t={tEn} />)
    expect(screen.getByRole('dialog').textContent).toContain('Not captured')
    b.rerender(<TokenText text="The cat sat." logprobs={probs} t={tEn} />)
    fireEvent.click(screen.getByRole('button', { name: /sat.*1/ }))
    b.rerender(<TokenText text="The cat sat." logprobs={{ tokens: ['The cat sat.'], logprobs: [-1], top: [] }} t={tEn} />)
    expect(screen.getByRole('dialog').textContent).toContain('Not captured')
  })
  it('branches only from the explicit alternate token action', () => {
    const onAlternative = vi.fn()
    render(<TokenText text="The cat sat." logprobs={probs} t={tEn} onAlternative={onAlternative} />)
    fireEvent.click(screen.getByRole('button', { name: /The.*90/ }))
    fireEvent.click(screen.getByRole('button', { name: /A.*10/ }))
    expect(onAlternative).toHaveBeenCalledWith(0, probs.top[0]![0])
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('selects a token column path and continues with its recorded references', () => {
    const a = brandString<LoomProbeNode['id']>('a'), b = brandString<LoomProbeNode['id']>('b'), n = brandString<LoomNodeId>('n')
    const branch = vi.fn()
    const value = { requests: 2, truncated: true, nodes: [
      { id: a, parent: null, sourceNodeId: n, tokenIndex: 0, token: 'air', probability: .4, cumulativeProbability: .4, depth: 1 },
      { id: b, parent: a, sourceNodeId: n, tokenIndex: 0, token: ' below', probability: .5, cumulativeProbability: .2, depth: 2 },
    ] }
    render(<ProbePanel value={value} prefix={[]} t={tEn} disabled={false} branch={branch} />)
    expect(screen.getByText('Selected path: air below')).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Select a recorded token path' }), { target: { value: a } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue from this path' }))
    expect(branch).toHaveBeenCalledWith([{ text: 'air', author: 'alternative', node: n, tokenIndex: 0 }])
    expect(screen.getByText(/Exploration budget reached/)).toBeTruthy()
    cleanup()
    render(<ProbePanel value={{ nodes: [], requests: 0, truncated: false }} prefix={[]} t={tEn} disabled={false} branch={branch} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
