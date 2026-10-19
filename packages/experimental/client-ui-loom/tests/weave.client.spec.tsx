// @vitest-environment jsdom
/** Weave keeps previews separate from choices and sends exact attributed cursor requests. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createLoomViewStore } from '../src/client/view-store.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LoomNodeId, LoomProbeNode, LoomWeaveNode, LoomWeaveState } from '@deepseek-ai/dsh-experimental-loom/types'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { WeaveView, type WeaveViewProps } from '../src/client/WeaveView.tsx'
import { tEn } from './fixtures.client.ts'

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const flush = async () => { await act(async () => { for (let n = 0; n < 6; n++) await Promise.resolve() }) }
const N = brandString<LoomNodeId>('node'), B = brandString<LoomNodeId>('b')
const node: LoomWeaveNode = { id: N, parent: null, requestSeq: SessionSeq(1), index: 0, kind: 'weave', prefix: [{ text: 'Opening ', author: 'user' }], text: 'air', status: 'completed', logprobs: { tokens: ['air'], logprobs: [Math.log(.3)], top: [[{ token: 'sea', logprob: Math.log(.2) }]] } }
const second: LoomWeaveNode = { ...node, id: B, text: 'water', index: 1 }
const empty: LoomWeaveState = { nodes: [], choices: [], curationBits: 0, modelTokens: 0 }
const refusal = () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'failed', {}) })
function bench(state = empty) {
  let read: unknown = { status: 'ready', value: state, refreshing: false }
  const useLoomWeave = vi.fn(() => read)
  const weave = vi.fn(async () => ({ ok: true as const, value: { requestSeq: SessionSeq(1), schedule: 'burst' as const, nodes: [node, second] } }))
  const choose = vi.fn(async () => ({ ok: true as const, value: { curationBits: 1, modelTokens: 2 } }))
  const p = brandString<LoomProbeNode['id']>('p')
  const probe = vi.fn(async () => ({ ok: true as const, value: { requests: 1, truncated: false, nodes: [{ id: p, parent: null, sourceNodeId: N, tokenIndex: 0, token: 'sea', probability: .2, cumulativeProbability: .2, depth: 1 }] } }))
  const refreshWeave = vi.fn(), exportLoom = vi.fn()
  const store = createLoomViewStore().create()
  const props = {
    useStore: bindSnapshotSelector(store), actions: store.actions,
    useProjection: (_name: string, select: (value: undefined) => unknown) => select(undefined),
    useLoomRoutes: (select: (value: { status: 'unavailable' }) => unknown) => select({ status: 'unavailable' }),
    loadRoutes: vi.fn(), useLoomEstimate: () => undefined,
    sessionId: SessionId('root'), useLoomWeave, weave, choose, probe, refreshWeave, exportLoom, t: tEn,
  } as never as WeaveViewProps
  const view = render(<WeaveView {...props} />)
  return {
    ...view, props, store, weave, choose, probe, refreshWeave, exportLoom,
    show(value: unknown) { read = value; view.rerender(<WeaveView {...props} />) },
  }
}
describe('Weave prose', () => {
  it('offers loading and retry states, then creates exact human cursor text with explicit limits', async () => {
    const b = bench()
    b.show(undefined); expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Loading prose')
    b.show({ status: 'loading' }); expect(screen.getByRole('status')).toBeTruthy()
    b.show({ status: 'failed' }); fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Retry' })); expect(b.refreshWeave).toHaveBeenCalledWith('root')
    b.show({ status: 'ready', value: empty, refreshing: false })
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox'), { target: { value: 'Hello beyond', selectionStart: 5 } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Continuations' }), { target: { value: '2' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum tokens each' }), { target: { value: '12' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Weave' })); await flush()
    expect(b.weave).toHaveBeenCalledWith({ sessionId: 'root', parent: null, prefix: [{ text: 'Hello', author: 'user' }], n: 2, controls: { maxTokens: 12 } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Export path' })); expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Close export' })); expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('previews retained siblings and records a choice before it becomes document text', async () => {
    const b = bench({ ...empty, nodes: [node, second] })
    const candidates = screen.getByLabelText('Retained continuations')
    fireEvent.click(within(candidates).getByRole('button', { name: /Variant 2/ }))
    expect(b.choose).not.toHaveBeenCalled(); expect(screen.getByText(/Preview; outside/)).toBeTruthy()
    fireEvent.click(within(candidates).getAllByRole('button', { name: 'Choose continuation' })[0]!)
    await flush(); expect(b.choose).toHaveBeenCalledWith({ sessionId: 'root', nodeId: N })
    expect((screen.getByRole<HTMLTextAreaElement>('textbox')).value).toBe('Opening air')
    expect(screen.getByText('Human text')).toBeTruthy(); expect(screen.getByText('Model text')).toBeTruthy()
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Show alternatives' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Variant 2/ })).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: /air: probability/ })[0]!)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: /sea.*20/ })); await flush()
    expect(b.weave).toHaveBeenLastCalledWith(expect.objectContaining({ parent: N, prefix: [{ text: 'Opening ', author: 'user' }, { text: 'sea', author: 'alternative', node: N, tokenIndex: 0 }] }))
  })
  it('explores the cursor with explicit bounds and continues from a captured alternate path', async () => {
    const b = bench()
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox'), { target: { value: 'Opening ' } })
    fireEvent.click(screen.getByText('Token multiverse at the cursor'))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Depth' }), { target: { value: '3' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Minimum probability' }), { target: { value: '.1' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Explore tokens' })); await flush()
    expect(b.probe).toHaveBeenCalledWith({ sessionId: 'root', parent: null, prefix: [{ text: 'Opening ', author: 'user' }], depth: 3, cutoff: .1 })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Continue from this path' })); await flush()
    expect(b.weave).toHaveBeenLastCalledWith(expect.objectContaining({ prefix: [{ text: 'Opening ', author: 'user' }, { text: 'sea', author: 'alternative', node: N, tokenIndex: 0 }] }))
  })
  it('supports prose keys outside editor controls and honors failed or cancelled candidates', async () => {
    const b = bench({ ...empty, nodes: [node, { ...second, text: '', status: 'cancelled', logprobs: undefined } as never] })
    const root = screen.getByRole('region', { name: 'Weave prose' })
    fireEvent.keyDown(root, { key: 'ArrowDown' }); expect(screen.getByRole<HTMLButtonElement>('button', { name: /Variant 1/ }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.keyDown(root, { key: 'ArrowUp' }); expect(screen.getByRole<HTMLButtonElement>('button', { name: /Variant 2/ }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.keyDown(root, { key: '2' }); expect(b.choose).not.toHaveBeenCalled()
    fireEvent.keyDown(root, { key: '9' }); fireEvent.keyDown(root, { key: 'x' }); fireEvent.keyDown(root, { key: 'g', ctrlKey: true }); expect(b.weave).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole<HTMLTextAreaElement>('textbox'), { key: 'g' }); expect(b.weave).not.toHaveBeenCalled()
    fireEvent.keyDown(root, { key: '1' }); await flush(); expect(b.choose).toHaveBeenCalledOnce()
    fireEvent.keyDown(root, { key: 'g' }); await flush(); expect(b.weave).toHaveBeenCalledOnce()
  })
  it('retains partial failed text with visible recovery status and diagnostic details', () => {
    bench({ ...empty, nodes: [{ ...node, status: 'failed', text: 'Partial answer', error: 'Provider stream closed', failureCode: 'NETWORK' },
      { ...second, status: 'cancelled', text: 'Stopped answer', failureCode: 'ABORTED' }] })
    expect(screen.getByText('Partial answer')).toBeTruthy()
    expect(screen.getByText('Stopped answer')).toBeTruthy()
    expect(screen.getByText(/This continuation did not complete/)).toBeTruthy()
    expect(screen.getByText('The prose request was cancelled. Recorded text and candidates remain.')).toBeTruthy()
    expect(screen.getAllByText('Failure details')).toHaveLength(2)
    expect(screen.getByText('Provider stream closed')).toBeTruthy()
    expect(screen.getByText('ABORTED')).toBeTruthy()
    expect(screen.getAllByRole<HTMLButtonElement>('button', { name: 'Choose continuation' }).every(button => button.disabled)).toBe(true)
  })
  it('preserves model text before a later alternative and shows the in-flight generation state', async () => {
    const two: LoomWeaveNode = { ...node, text: 'air below', logprobs: { tokens: ['air', ' below'], logprobs: [-1, -2], top: [[], [{ token: ' above', logprob: -2 }]] } }
    const b = bench({ ...empty, nodes: [two], choices: [{ version: 1, nodeId: N, requestSeq: SessionSeq(1), alternatives: 1 }] })
    let finish!: () => void
    b.weave.mockImplementationOnce(() => new Promise((resolve) => { finish = () => { resolve({ ok: true, value: { requestSeq: SessionSeq(2), schedule: 'burst', nodes: [] } }) } }))
    fireEvent.click(screen.getAllByRole('button', { name: /below: probability/ })[0]!)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: /above/ }))
    expect(b.weave).toHaveBeenCalledWith(expect.objectContaining({ prefix: [node.prefix[0], { text: 'air', author: 'model', node: N }, { text: ' above', author: 'alternative', node: N, tokenIndex: 1 }] }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Generating…' })).toBeTruthy()
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Show alternatives' }))
    fireEvent.keyDown(screen.getByRole('region', { name: 'Weave prose' }), { key: '1' })
    expect(b.choose).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button', { name: /below: probability/ })[0]!)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: /above/ }))
    expect(b.weave).toHaveBeenCalledOnce()
    await act(async () => { finish() })
    fireEvent.select(screen.getByRole<HTMLTextAreaElement>('textbox'), { target: { selectionStart: 2 } })
  })

  it('retains every unchosen request and exact editor attribution across a remount', async () => {
    const opening = [...node.prefix, { text: node.text, author: 'model' as const, node: N }]
    const bNode = { ...node, id: brandString<LoomNodeId>('request-b'), parent: N, requestSeq: SessionSeq(2), prefix: opening, text: ' below' }
    const cNode = { ...bNode, id: brandString<LoomNodeId>('request-c'), requestSeq: SessionSeq(3), text: ' above' }
    const b = bench({ ...empty, nodes: [node, bNode, cNode],
      choices: [{ version: 1, nodeId: N, requestSeq: SessionSeq(1), alternatives: 1 }] })
    const history = screen.getByRole('combobox', { name: 'Retained requests' })
    fireEvent.change(history, { target: { value: '2' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Variant 1.*below/ })).toBeTruthy()
    fireEvent.change(history, { target: { value: '3' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Variant 1.*above/ })).toBeTruthy()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Temperature' }), { target: { value: '0.7' } })
    b.unmount(); render(<WeaveView {...b.props} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Variant 1.*above/ })).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Retained requests' }), { target: { value: '2' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Weave' })); await flush()
    expect(b.weave).toHaveBeenCalledWith(expect.objectContaining({ prefix: opening, controls: { maxTokens: 70, temperature: .7 } }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Temperature' }), { target: { value: '' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Retained requests' }), { target: { value: '' } })
  })

  it('keeps unsubmitted human prose and cursor when the panel remounts', () => {
    const b = bench()
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox'), { target: { value: 'Unsent draft', selectionStart: 3 } })
    b.unmount(); render(<WeaveView {...b.props} />)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Unsent draft')
    expect(b.store.getSnapshot().prose.cursor).toBe(3)
  })

  it('uses a local model override for prose and probing while explicitly showing thinking off', async () => {
    const b = bench({ ...empty, nodes: [{ ...node, text: '', status: 'failed' }] })
    b.rerender(<WeaveView {...b.props}
      useProjection={((_name: string, select: (value: object) => unknown) => select({ next: { provider: 'base', model: 'base', reasoningEffort: 'high' } })) as WeaveViewProps['useProjection']}
      useLoomRoutes={((select: (value: object) => unknown) => select({ status: 'ready', options: [{ selection: { provider: 'p', model: 'm' }, providerName: 'P', modelName: 'M', efforts: [] }] })) as WeaveViewProps['useLoomRoutes']} />)
    expect(screen.getByText('Off for auxiliary prose calls')).toBeTruthy()
    expect(screen.getByText(/This continuation did not complete/)).toBeTruthy()
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Change' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /P.*M/ }))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Weave' })); await flush()
    expect(b.weave).toHaveBeenCalledWith(expect.objectContaining({ route: { provider: 'p', model: 'm' } }))
    fireEvent.click(screen.getByText('Token multiverse at the cursor'))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Explore tokens' })); await flush()
    expect(b.probe).toHaveBeenCalledWith(expect.objectContaining({ route: { provider: 'p', model: 'm' } }))
  })

  it('keeps text and candidates after each Host refusal or rejection', async () => {
    const b = bench({ ...empty, nodes: [node, second] })
    b.weave.mockResolvedValueOnce(refusal() as never).mockRejectedValueOnce(new Error('offline'))
    for (let i = 0; i < 2; i++) { fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Weave' })); await flush(); expect(screen.getByRole('alert')).toBeTruthy() }
    b.choose.mockResolvedValueOnce(refusal() as never).mockRejectedValueOnce(new Error('offline'))
    for (let i = 0; i < 2; i++) { fireEvent.click(screen.getAllByRole('button', { name: 'Choose continuation' })[0]!); await flush(); expect(screen.getByRole('alert')).toBeTruthy() }
    b.probe.mockResolvedValueOnce(refusal() as never).mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByText('Token multiverse at the cursor'))
    for (let i = 0; i < 2; i++) { fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Explore tokens' })); await flush(); expect(screen.getByRole('alert')).toBeTruthy() }
    expect((screen.getByRole<HTMLTextAreaElement>('textbox')).value).toBe('Opening ')
  })
  it('reconstructs persisted selected prose and blocks mutations while its read refreshes', () => {
    const b = bench({ nodes: [node, { ...second, parent: N, prefix: [{ text: 'sea', author: 'alternative', node: N, tokenIndex: 0 }], text: ' plain', logprobs: undefined } as never], choices: [{ version: 1, nodeId: B, requestSeq: SessionSeq(1), alternatives: 2 }], curationBits: 1, modelTokens: 2 })
    expect((screen.getByRole<HTMLTextAreaElement>('textbox')).value).toBe('sea plain')
    expect(screen.getByText('Chosen alternative token')).toBeTruthy()
    b.show({ status: 'ready', value: empty, refreshing: true })
    expect((screen.getByRole<HTMLButtonElement>('button', { name: 'Weave' })).disabled).toBe(true)
    fireEvent.keyDown(screen.getByRole('region', { name: 'Weave prose' }), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('region', { name: 'Weave prose' }), { key: 'g' }); expect(b.weave).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Continuations' }), { target: { value: '0' } })
    expect((screen.getByRole<HTMLButtonElement>('button', { name: 'Weave' })).disabled).toBe(true)
  })
})
