// @vitest-environment jsdom
/** The anchored panel shell: where focus goes when it opens and when it closes. */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { LoomPanel, useAnchoredPanel } from '../src/client/panel.tsx'

afterEach(() => {
  cleanup()
})

/** A trigger and an optional panel with the given content and a closing control. */
function Probe({ children, rendered = true }: { children?: ReactNode; rendered?: boolean }) {
  const panel = useAnchoredPanel('bottom')
  return (
    <>
      <span ref={panel.anchorRef}>
        <button type="button" aria-haspopup="dialog" onClick={() => { panel.setOpen(!panel.open) }}>Open</button>
      </span>
      <button type="button">Elsewhere</button>
      {rendered && (
        <LoomPanel panel={panel} label="Probe">
          {children}
          <button type="button" onClick={panel.close}>Done</button>
        </LoomPanel>
      )}
    </>
  )
}

function open(): HTMLElement {
  const trigger = screen.getByRole('button', { name: 'Open' })
  fireEvent.click(trigger)
  return trigger
}

describe('anchored panel focus', () => {
  it('focuses the checked radio before any earlier control', () => {
    render(
      <Probe>
        <button type="button">First</button>
        <button type="button" role="radio" aria-checked="false">One</button>
        <button type="button" role="radio" aria-checked="true">Two</button>
      </Probe>,
    )
    open()
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Two' }))
  })

  it('focuses the first enabled control without a checked radio, and leaves focus that is already inside', () => {
    const { unmount } = render(<Probe><button type="button" disabled>Off</button></Probe>)
    open()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Done' }))
    unmount()
    render(<Probe><input aria-label="Own" autoFocus /></Probe>)
    open()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Own' }))
  })

  it('returns focus to the trigger when it closes with focus inside, and leaves focus the reader moved elsewhere', () => {
    render(<Probe />)
    const trigger = open()
    const done = screen.getByRole('button', { name: 'Done' })
    fireEvent.click(done)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    open()
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' })
    act(() => { elsewhere.focus() })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(elsewhere)
  })

  it('moves no focus while the panel is not rendered', () => {
    render(<Probe rendered={false} />)
    const trigger = open()
    expect(document.activeElement).toBe(document.body)
    act(() => { trigger.focus() })
    expect(document.activeElement).toBe(trigger)
  })
})
