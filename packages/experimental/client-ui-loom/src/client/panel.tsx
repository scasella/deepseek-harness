/**
 * Anchored popover shell of the Regenerate and Edit-and-branch panels: a
 * dialog portaled to the document body, fixed beside its trigger and clamped
 * inside the viewport, closed by Escape or a pointer outside trigger and
 * panel. Once placed, the panel focuses its checked radio, else its first
 * enabled control, unless focus is already inside it. Escape and every close
 * the panel's own controls make return focus to the trigger that opened it,
 * the button with `aria-haspopup="dialog"`, when focus was inside the panel or
 * was lost with it; while a menu is open inside the panel, Escape belongs to
 * that menu.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './panel.module.css'

/** Viewport margin of the placement clamp, the Menu portal margin. */
const PANEL_MARGIN = 12
/** Distance between the trigger and the panel. */
const PANEL_GAP = 8
/** Unplaced panel: laid out but hidden so the clamp measures its real size. */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }
/** Controls an opened panel may focus when it has no checked radio. */
const FOCUSABLE = 'textarea, input, select, button:not(:disabled)'

/** Open state, refs, and placement of one anchored panel. */
export interface AnchoredPanel {
  readonly open: boolean
  /** Open or close without moving focus, for the trigger's own toggle. */
  readonly setOpen: (open: boolean) => void
  /** Close and return focus to the trigger when focus was inside the panel or lost with it. */
  readonly close: () => void
  /** Element holding the trigger; the panel is placed from it and a pointer inside it does not dismiss. */
  readonly anchorRef: MutableRefObject<HTMLSpanElement | null>
  readonly panelRef: MutableRefObject<HTMLDivElement | null>
  readonly position: CSSProperties | null
}

/**
 * Hold one anchored panel.
 * @param side - which side of the trigger the panel opens on.
 * @returns the panel's state and refs.
 */
export function useAnchoredPanel(side: 'top' | 'bottom'): AnchoredPanel {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const position = useAnchoredPosition({ open, anchorRef, panelRef, side, gap: PANEL_GAP, margin: PANEL_MARGIN })
  const placed = position !== null
  // A pointer outside moves focus where it pressed, so that dismissal leaves focus alone.
  useDismissOnOutsidePointer(anchorRef, open, setOpen, panelRef)
  const close = useCallback((): void => {
    const focused = document.activeElement
    const held = focused === null || focused === document.body || panelRef.current?.contains(focused) === true
    setOpen(false)
    if (held) anchorRef.current?.querySelector<HTMLElement>('[aria-haspopup="dialog"]')?.focus()
  }, [])
  // The unplaced panel is hidden and cannot take focus, so focus moves in once it is placed.
  useEffect(() => {
    const panel = panelRef.current
    if (!open || !placed || panel === null || panel.contains(document.activeElement)) return
    const first = panel.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? panel.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
  }, [open, placed])
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || panelRef.current?.querySelector('[role="menu"]') != null) return
      close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, close])
  return { open, setOpen, close, anchorRef, panelRef, position }
}

/**
 * Render an open panel's dialog.
 * @param props.panel - the panel state.
 * @param props.label - localized accessible name of the dialog.
 * @param props.children - dialog content.
 * @returns the portaled dialog, or null while closed.
 */
export function LoomPanel({ panel, label, children }: { panel: AnchoredPanel; label: string; children: ReactNode }) {
  if (!panel.open) return null
  return createPortal(
    <div ref={panel.panelRef} role="dialog" aria-label={label} className={css.panel} style={panel.position ?? MEASURE_STYLE}>
      {children}
    </div>,
    document.body,
  )
}
