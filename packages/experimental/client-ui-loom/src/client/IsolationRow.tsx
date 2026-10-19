/**
 * The Workspace row of the Regenerate panel and the Branch ×N form: whether
 * branches run one at a time in the shared folder or each in its own git
 * worktree. The worktree option says what a worktree starts from, and it is
 * disabled with the Host's reason once the Host has refused it. The Host
 * reports no capability up front, so both options are offered until then.
 */
import { useRef, type KeyboardEvent } from 'react'
import { classes } from './classes.ts'
import { isolationReasonText, type LoomTranslate } from './format.ts'
import type { LoomKey } from './locales.ts'
import type { LoomIsolation, LoomIsolationUnavailableReason } from '@deepseek-ai/dsh-experimental-loom/types'
import panelCss from './panel.module.css'
import css from './IsolationRow.module.css'

/** Props of the Workspace row. */
export interface IsolationRowProps {
  readonly value: LoomIsolation
  /** Why the Host refused worktree isolation; null while it has not been tried or was not refused. */
  readonly unavailable: LoomIsolationUnavailableReason | null
  /** Whether a request is in flight. */
  readonly disabled?: boolean
  readonly onChange: (value: LoomIsolation) => void
  readonly t: LoomTranslate
}

/** Copy of each option. */
const OPTIONS = [
  { value: 'shared', label: 'isolation.shared', note: 'workspace.shared' },
  { value: 'worktree', label: 'isolation.worktree', note: 'isolation.worktreeNote' },
] as const satisfies readonly { value: LoomIsolation; label: LoomKey; note: LoomKey }[]

/**
 * Render the Workspace term and its choice in a details grid.
 * @param props - the choice, the Host's refusal, and copy.
 * @returns the `dt`/`dd` pair.
 */
export function IsolationRow({ value, unavailable, disabled = false, onChange, t }: IsolationRowProps) {
  const group = useRef<HTMLDivElement>(null)
  const choose = (next: LoomIsolation | undefined): void => {
    if (next === undefined || next === value) return
    onChange(next)
    group.current?.querySelector<HTMLButtonElement>(`[data-isolation="${next}"]`)?.focus()
  }
  // Arrows move between the enabled options; with one enabled option there is nowhere to move.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) return
    event.preventDefault()
    choose(OPTIONS.find(option => option.value !== value && !(option.value === 'worktree' && unavailable !== null))?.value)
  }
  return (
    <>
      <dt>{t('workspace.title')}</dt>
      <dd>
        <div ref={group} role="radiogroup" aria-label={t('isolation.aria')} className={css.group}>
          {OPTIONS.map((option) => {
            const refused = option.value === 'worktree' && unavailable !== null
            const checked = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                data-isolation={option.value}
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                disabled={disabled || refused}
                className={classes(css.option, checked && css.checked)}
                onClick={() => { choose(option.value) }}
                onKeyDown={onKeyDown}
              >
                <span className={css.dot} aria-hidden="true" />
                <span className={css.text}>
                  <span className={css.label}>{t(option.label)}</span>
                  <span className={panelCss.second}>
                    {refused ? t('isolation.unavailable', { reason: isolationReasonText(unavailable, t) }) : t(option.note)}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </dd>
    </>
  )
}
