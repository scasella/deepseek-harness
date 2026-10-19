/** Full-text tooltips for truncated Loom labels, shown only while the label is clipped. */
import { useLayoutEffect, useRef, useState, type ReactElement, type RefObject } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

/** Widest tooltip bubble, so a long title wraps instead of spanning the window. */
const TOOLTIP_MAX_WIDTH = 360

/**
 * Track whether an ellipsized element hides part of its text.
 * @param text - the element's text; a change re-measures.
 * @returns a ref for the measured element and whether its content overflows it.
 */
export function useClipped<T extends HTMLElement>(text: string): [RefObject<T>, boolean] {
  const ref = useRef<T>(null)
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    /* v8 ignore next -- every caller renders the measured element unconditionally. */
    if (element === null) return undefined
    const measure = (): void => { setClipped(element.scrollWidth > element.clientWidth) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [text])
  return [ref, clipped]
}

/**
 * Show a label's full text above an anchor while the measured text is clipped.
 * @param props.label - full text.
 * @param props.clipped - whether the anchor's text is clipped.
 * @param props.children - the anchor element.
 * @returns the anchor with its tooltip.
 */
export function ClippedTooltip({ label, clipped, children }: { label: string; clipped: boolean; children: ReactElement }) {
  return (
    <Tooltip label={label} side="top" delayMs={500} portal maxWidth={TOOLTIP_MAX_WIDTH} disabled={!clipped}>
      {children}
    </Tooltip>
  )
}

/**
 * Render one ellipsized text with its full text in a tooltip while clipped.
 * @param props.text - full text.
 * @param props.className - class that ellipsizes the text.
 * @param props.as - element to render; a `dd` keeps description-list markup valid.
 * @returns the text element.
 */
export function ClippedText({ text, className, as = 'span' }: { text: string; className?: string | undefined; as?: 'span' | 'dd' }) {
  const [ref, clipped] = useClipped<HTMLElement>(text)
  return (
    <ClippedTooltip label={text} clipped={clipped}>
      {as === 'dd' ? <dd ref={ref} className={className}>{text}</dd> : <span ref={ref} className={className}>{text}</span>}
    </ClippedTooltip>
  )
}
