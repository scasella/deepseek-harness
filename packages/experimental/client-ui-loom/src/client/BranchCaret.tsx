/**
 * The Branch ×N caret right after Branch on a completed Turn: it opens, or
 * closes, the Branch ×N form in this Session's input dock for branches cut
 * at the end of this Turn. It renders nothing before the Turn's `turn/end`
 * is known or without branch access.
 */
import { IconChevronDownOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { classes } from './classes.ts'
import { useHoverCapable } from './hover.ts'
import type { LoomTailProps } from './tail.ts'
import css from './TailActions.module.css'

/**
 * Render the caret.
 * @param props - the Turn, branching state and verbs, access, and copy.
 * @returns the caret, or null.
 */
export function BranchCaret({ sessionId, turn, turnEndSeq, useAccess, useLoomBranching, openForm, closeForm, t }: LoomTailProps) {
  const allowed = useAccess('loom/branch')
  const open = useLoomBranching((state) => {
    const form = state.forms[sessionId]
    return form?.sourceSessionId === sessionId && form.afterTurn === turn.turn
  })
  const hover = useHoverCapable()
  if (!allowed || turnEndSeq === undefined) return null
  return (
    <Tooltip label={t('tail.branchSeveral')} side="bottom" disabled={!hover}>
      <button
        type="button"
        className={classes(css.action, css.caret, open && css.open)}
        aria-label={t('tail.branchSeveral')}
        aria-expanded={open}
        data-loom-branch-caret=""
        onClick={() => {
          if (open) closeForm(sessionId)
          else openForm(sessionId, { sourceSessionId: sessionId, afterTurn: turn.turn })
        }}
      >
        <IconChevronDownOutlineRegular size={12} />
      </button>
    </Tooltip>
  )
}
