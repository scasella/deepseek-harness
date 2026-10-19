// @vitest-environment jsdom
/** Mobile variants keep every title reachable and release the viewport subscription. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { useLoomMobile } from '../src/client/mobile.ts'
import { VariantSheet } from '../src/client/VariantSheet.tsx'
import { listOf, tEn } from './fixtures.client.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('mobile Loom', () => {
  it('uses the viewport query when available and removes its listener', () => {
    const plain = renderHook(useLoomMobile); expect(plain.result.current).toBe(false); plain.unmount()
    let changed: () => void = () => {}
    const removeEventListener = vi.fn()
    const media = {
      matches: true, addEventListener: vi.fn((_name: string, listener: () => void) => { changed = listener }), removeEventListener,
    }
    vi.stubGlobal('matchMedia', vi.fn(() => media))
    const b = renderHook(useLoomMobile); expect(b.result.current).toBe(true)
    act(() => { media.matches = false; changed() }); expect(b.result.current).toBe(false)
    b.unmount(); expect(removeEventListener).toHaveBeenCalledWith('change', changed)
  })
  it('lists complete sibling titles, marks the current one and returns to the source', () => {
    const close = vi.fn(), select = vi.fn(), list = listOf([{ id: 'root' }, { id: 'a', parent: 'root' }, { id: 'b', parent: 'root' }])
    render(<VariantSheet open close={close} members={[SessionId('a'), SessionId('b')]} current={SessionId('a')} parent={SessionId('root')} list={list} cut="after turn 1" select={select} t={tEn} />)
    expect(screen.getByRole('dialog', { name: 'Variants after turn 1' })).toBeTruthy()
    const current = screen.getByRole('button', { name: /1\s*title a/ }); expect(current.getAttribute('aria-current')).toBe('true')
    fireEvent.click(current); expect(select).toHaveBeenCalledWith('a')
    fireEvent.click(screen.getByRole('button', { name: /2\s*title b/ })); expect(select).toHaveBeenCalledWith('b')
    fireEvent.click(screen.getByRole('button', { name: 'Branched from title root' })); expect(select).toHaveBeenCalledWith('root')
    fireEvent.click(screen.getByRole('button', { name: 'Close variants' })); expect(close).toHaveBeenCalledTimes(4)
  })
})
