// @vitest-environment jsdom
/** Explicit export and result-edit actions retain edits through failures and expose partial commits. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ExportDialog } from '../src/client/ExportDialog.tsx'
import { CounterfactualAction, type CounterfactualActionProps } from '../src/client/CounterfactualAction.tsx'
import { tEn } from './fixtures.client.ts'

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const flush = async () => { await act(async () => { for (let n = 0; n < 5; n++) await Promise.resolve() }) }
const error = () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'failed', {}) })
const state = { nodes: [], choices: [], curationBits: 0, modelTokens: 0 }
describe('prose exports', () => {
  it('prepares only on Download and sends explicit scope/format while always showing curation facts', async () => {
    const exportLoom = vi.fn(async () => ({ ok: true as const, value: { url: '/download/path', filename: 'path.json', mimeType: 'application/json' } }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const close = vi.fn()
    render(<ExportDialog open close={close} sessionId={SessionId('root')} state={state} preview="prose" exportLoom={exportLoom} t={tEn} />)
    expect(exportLoom).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: 'Path and siblings' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Format' }), { target: { value: 'json' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Download' })); await flush()
    expect(exportLoom).toHaveBeenCalledWith({ sessionId: 'root', mode: 'siblings', format: 'json' })
    expect(click).toHaveBeenCalledOnce(); expect(screen.getByRole('status').textContent).toBe('Download started')
    fireEvent.click(screen.getByRole('radio', { name: 'Kept branches only' }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'text' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Download' })); await flush()
    expect(exportLoom).toHaveBeenLastCalledWith({ sessionId: 'root', mode: 'kept', format: 'text' })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' })); expect(close).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Close export' })); expect(close).toHaveBeenCalledTimes(2)
  })
  it('keeps failed exports in the dialog and supports a selected node', async () => {
    const exportLoom = vi.fn().mockResolvedValueOnce(error()).mockRejectedValueOnce(new Error('offline'))
    render(<ExportDialog open close={() => {}} sessionId={SessionId('root')} nodeId={'node' as never} state={{ ...state, modelTokens: 10, curationBits: 2 }} preview="" exportLoom={exportLoom} t={tEn} />)
    for (let attempt = 0; attempt < 2; attempt++) { fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Download' })); await flush(); expect(screen.getByRole('alert')).toBeTruthy() }
    expect(exportLoom).toHaveBeenCalledWith({ sessionId: 'root', nodeId: 'node', mode: 'path', format: 'html' })
  })
})

function counterProps(extra: Partial<CounterfactualActionProps> = {}): CounterfactualActionProps {
  return { sessionId: SessionId('root'), phase: 'result', block: { kind: 'tool-result', seq: SessionSeq(4), name: 'read', content: [{ type: 'text', text: 'original' }, { type: 'image', data: 'abc', mimeType: 'image/png' }], callId: 'call' },
    counterfactual: vi.fn(async () => ({ ok: true, value: { sessionId: SessionId('child'), replacementSeq: SessionSeq(5) } })), openSession: vi.fn(), t: tEn, ...extra } as CounterfactualActionProps
}
describe('counterfactual result editor', () => {
  it('appears only on a durable top-level result, edits text and opens the completed branch', async () => {
    const props = counterProps()
    const b = render(<CounterfactualAction {...props} phase={'running' as never} />)
    expect(screen.queryByRole('button')).toBeNull()
    b.rerender(<CounterfactualAction {...counterProps({ block: { ...props.block, parentCallId: 'nested' } as never })} />)
    expect(screen.queryByRole('button')).toBeNull()
    b.rerender(<CounterfactualAction {...counterProps({ block: { ...props.block, seq: NaN } as never })} />)
    expect(screen.queryByRole('button')).toBeNull()
    b.rerender(<CounterfactualAction {...props} />)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Edit result & branch' }))
    expect((screen.getByRole<HTMLTextAreaElement>('textbox')).value).toBe('original')
    fireEvent.change(screen.getByRole<HTMLTextAreaElement>('textbox'), { target: { value: 'edited' } })
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Branch & continue' })); await flush()
    expect(props.counterfactual).toHaveBeenCalledWith({ sessionId: 'root', resultSeq: 4, content: [{ type: 'text', text: 'edited' }] })
    expect(props.openSession).toHaveBeenCalledWith('child')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('preserves edits on failure and exposes the already-created child after an incomplete continuation', async () => {
    const counterfactual = vi.fn().mockResolvedValueOnce(error()).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: false, error: new RemoteError('loom/counterfactual-incomplete', 'failed', { sessionId: SessionId('root'), childSessionId: SessionId('child'), reason: 'offline' }) })
    const props = counterProps({ counterfactual })
    render(<CounterfactualAction {...props} />)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Edit result & branch' }))
    for (let attempt = 0; attempt < 3; attempt++) { fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Branch & continue' })); await flush(); expect(screen.getByRole('alert')).toBeTruthy() }
    expect((screen.getByRole<HTMLButtonElement>('button', { name: 'Branch & continue' })).disabled).toBe(true)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Open created branch' })); expect(props.openSession).toHaveBeenCalledWith('child')
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' })); expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Edit result & branch' }))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Close result editor' })); expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('pending prose writes', () => {
  it('keeps the result editor open while creation has not settled', async () => {
    let finish!: (value: Awaited<ReturnType<CounterfactualActionProps['counterfactual']>>) => void
    const counterfactual = vi.fn(() => new Promise<Awaited<ReturnType<CounterfactualActionProps['counterfactual']>>>((resolve) => { finish = resolve }))
    render(<CounterfactualAction {...counterProps({ counterfactual })} />)
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Edit result & branch' }))
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Branch & continue' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Creating branch…' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    await act(async () => { finish(error()) })
    fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull()
  })
})
