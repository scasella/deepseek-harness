/** Disclosure row standing for a fork's inherited Turns. */
import { memo } from 'react'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatFlowSlotProps } from '../contract/slots.ts'
import { INHERITED_ROW_KEY } from './inherited-span.ts'
import chatCss from './ChatView.module.css'
import css from './InheritedSpanRow.module.css'

/** Inherited span summary and its controlled expansion. */
export interface InheritedSpanRowProps {
  /** Last inherited Turn; the span covers Turns 1 through it. */
  readonly turn: number
  /** Inherited closed steps, omitted from the label while unreported. */
  readonly steps: number | undefined
  readonly open: boolean
  readonly onToggle: () => void
  readonly t: ChatFlowSlotProps['t']
}

/**
 * Render the "Inherited from parent · turn N · S steps" row as a flow item
 * whose anchor key lets the viewport hold it in place while the span toggles.
 * @param props - span summary, expansion state, and dictionary.
 * @returns the disclosure row.
 */
export const InheritedSpanRow = memo(function InheritedSpanRow({ turn, steps, open, onToggle, t }: InheritedSpanRowProps) {
  const turns = turn === 1 ? t('fork.inherited.turn', { turn }) : t('fork.inherited.turns', { turn })
  const label = steps === undefined
    ? t('fork.inherited.label', { turns })
    : t('fork.inherited.labelSteps', {
      turns,
      steps: t(steps === 1 ? 'fork.inherited.steps.one' : 'fork.inherited.steps.other', { count: steps }),
    })
  return (
    <div className={chatCss.flowItem} data-chat-anchor-key={INHERITED_ROW_KEY} data-chat-flow-key={INHERITED_ROW_KEY}
      data-chat-flow-kind="fork-inherited">
      <button
        type="button"
        className={css.root}
        aria-expanded={open}
        data-open={open || undefined}
        onClick={(event) => {
          event.currentTarget.focus()
          onToggle()
        }}
      >
        <span className={css.label}>{label}</span>
        <IconChevronDownOutlineRegular className={css.chevron} />
      </button>
    </div>
  )
})
