/**
 * Choice of a small count, such as variants ×1/×2/×4: a radio group with one
 * tab stop whose arrows move and select, Home and End jumping to the ends.
 */
import { useRef, type KeyboardEvent } from 'react'
import { classes } from './classes.ts'
import css from './CountChoice.module.css'

/** Props of a count choice. */
export interface CountChoiceProps {
  /** Offered counts in display order. */
  readonly values: readonly number[]
  readonly value: number
  /** Localized accessible name of the group. */
  readonly label: string
  /** Visible text of one count. */
  readonly format: (count: number) => string
  readonly onChange: (count: number) => void
  readonly disabled?: boolean
}

/**
 * Render a count choice.
 * @param props - counts, selection, copy, and change callback.
 * @returns the radio group.
 */
export function CountChoice({ values, value, label, format, onChange, disabled = false }: CountChoiceProps) {
  const group = useRef<HTMLDivElement>(null)
  const choose = (next: number | undefined): void => {
    if (next === undefined || next === value) return
    onChange(next)
    group.current?.querySelector<HTMLButtonElement>(`[data-count="${String(next)}"]`)?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const at = values.indexOf(value)
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        choose(values[(at + 1) % values.length])
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        choose(values[(at - 1 + values.length) % values.length])
        break
      case 'Home': choose(values[0]); break
      case 'End': choose(values.at(-1)); break
      default: return
    }
    event.preventDefault()
  }
  return (
    <div ref={group} role="radiogroup" aria-label={label} className={css.group}>
      {values.map(count => (
        <button
          key={count}
          type="button"
          role="radio"
          data-count={count}
          aria-checked={count === value}
          tabIndex={count === value ? 0 : -1}
          disabled={disabled}
          className={classes(css.option, count === value && css.selected)}
          onClick={() => { choose(count) }}
          onKeyDown={onKeyDown}
        >
          {format(count)}
        </button>
      ))}
    </div>
  )
}
