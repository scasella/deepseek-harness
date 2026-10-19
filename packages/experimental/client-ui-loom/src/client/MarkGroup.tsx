/**
 * Keep and Set aside, the private curation marks, on the latest loaded Turn
 * of a Session in a fork family. They form their own group after Branch,
 * apart from Like and Dislike, and write `loom.mark` records that never
 * become feedback. A pressed mark clears on a second press.
 */
import type { ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LoomMark } from '@deepseek-ai/dsh-experimental-loom/types'
import { classes } from './classes.ts'
import { failureText } from './format.ts'
import { KeepGlyph, SetAsideGlyph } from './glyphs.tsx'
import { useHoverCapable } from './hover.ts'
import { markOf } from './lineage.ts'
import type { LoomTailProps } from './tail.ts'
import css from './TailActions.module.css'

/** Copy and glyph of each mark. */
const MARKS = [
  { mark: 'keep', label: 'marks.keep', hint: 'marks.keepHint', glyph: <KeepGlyph /> },
  { mark: 'set-aside', label: 'marks.setAside', hint: 'marks.setAsideHint', glyph: <SetAsideGlyph /> },
] as const satisfies readonly { mark: LoomMark; label: string; hint: string; glyph: ReactNode }[]

/**
 * Render the marks group.
 * @param props - the Turn, Chat, family, mark projection, branching verbs, and copy.
 * @returns the group, or null on an earlier Turn or outside a fork family.
 */
export function MarkGroup({
  sessionId, turn, useAccess, useChat, useProjection, useLoomFamily, useLoomBranching, setMark, t,
}: LoomTailProps) {
  const allowed = useAccess('loom/mark')
  const latest = useChat(snapshot => snapshot.timeline.turnOrder.at(-1) === turn.turn)
  const inFamily = useLoomFamily(sessionId, state => state?.status === 'ready' && state.family.nodes.length > 1)
  const projected = useProjection('loomMark')
  const override = useLoomBranching(state => state.marks[sessionId])
  const hover = useHoverCapable()
  if (!allowed || !latest || !inFamily) return null
  const current = markOf(projected, override)
  const saving = override?.status === 'saving'
  return (
    <span className={css.marks} role="group" aria-label={t('marks.aria')} data-loom-marks="">
      <span className={css.sep} aria-hidden="true" />
      {MARKS.map(entry => (
        <MarkButton
          key={entry.mark}
          pressed={current === entry.mark}
          disabled={saving}
          label={t(entry.label)}
          hint={t(entry.hint)}
          glyph={entry.glyph}
          hover={hover}
          onPress={() => { void setMark(sessionId, current === entry.mark ? null : entry.mark) }}
        />
      ))}
      {override?.status === 'failed' && <span className={css.status} role="status">{failureText(override.failure, t)}</span>}
    </span>
  )
}

/** One toggle of the group; its explanation is its accessible description and shows as a tooltip on hover devices only. */
function MarkButton({ pressed, disabled, label, hint, glyph, hover, onPress }: {
  pressed: boolean
  disabled: boolean
  label: string
  hint: string
  glyph: ReactNode
  hover: boolean
  onPress: () => void
}) {
  return (
    <Tooltip label={hint} side="bottom" disabled={!hover}>
      <button
        type="button"
        className={classes(css.pill, pressed && css.pressed)}
        aria-label={label}
        aria-description={hint}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onPress}
      >
        {glyph}
        <span className={css.label}>{label}</span>
      </button>
    </Tooltip>
  )
}
