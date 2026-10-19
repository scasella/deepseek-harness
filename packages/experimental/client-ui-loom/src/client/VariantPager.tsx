/**
 * Sibling pager "‹ k/N ›" on a fork's first own Turn: it steps to the
 * previous or next variant forked from the same parent at the same cut, in
 * family order. The pager is one tab stop: the arrow keys move between its
 * two buttons and Home and End open the first and last variant. Below 480px
 * it takes its own row with 44px targets.
 */
import { useMemo, useRef, type KeyboardEvent } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { classes } from './classes.ts'
import { forkCutOf, inheritedSplitOf, lastInheritedTurnOf, membersWithoutLineage, projectionValuesOf, variantsOf } from './lineage.ts'
import { useRefreshOnce } from './refresh.ts'
import type { LoomTailProps } from './tail.ts'
import css from './TailActions.module.css'

/**
 * Render the pager on a fork's first own Turn. Every completed Turn mounts
 * this entry, so it reads only the facts that place the first own Turn; the
 * body that follows the whole Session list mounts on that one Turn.
 * @param props - the Turn, Session list, family, navigation, and copy.
 * @returns the pager, or null on any other Turn or for a Session with one variant.
 */
export function VariantPager(props: LoomTailProps) {
  const { sessionId, turn, useSessions, useLoomFamily, refreshProjection } = props
  const members = useLoomFamily(sessionId, state => state?.status === 'ready' ? state.family.nodes.length : 0)
  const cutSeq = useSessions(state => forkCutOf(state, sessionId)?.cutSeq)
  const firstOwnTurn = useSessions((state) => {
    const values = projectionValuesOf(state, sessionId)
    const split = inheritedSplitOf(values)
    return split === undefined ? undefined : lastInheritedTurnOf(values, split) + 1
  })
  // The Session's own outline names a turn the cut interrupted.
  const outlineMissing = useSessions(state => cutSeq !== undefined && projectionValuesOf(state, sessionId)?.turnOutline === undefined)
  const pending = useMemo(() => outlineMissing ? [sessionId] : [], [outlineMissing, sessionId])
  useRefreshOnce(pending, refreshProjection)
  if (members < 2 || cutSeq === undefined || turn.turn !== firstOwnTurn) return null
  if (turn.start !== undefined && turn.start.seq <= cutSeq) return null
  return <VariantPagerBody {...props} />
}

/**
 * Render the pager of a Turn known to be the first own Turn of a fork.
 * @param props - the Turn, Session list, family, navigation, and copy.
 * @returns the pager, or null while the fork has fewer than two variants at its cut.
 */
export function VariantPagerBody({ sessionId, useSessions, useLoomFamily, openSession, refreshProjection, t }: LoomTailProps) {
  const list = useSessions(state => state)
  const familyState = useLoomFamily(sessionId)
  const family = familyState?.status === 'ready' ? familyState.family : undefined
  const variants = useMemo(() => family === undefined ? undefined : variantsOf(family, list, sessionId), [family, list, sessionId])
  const pending = useMemo(() => family === undefined ? [] : membersWithoutLineage(family, list), [family, list])
  useRefreshOnce(pending, refreshProjection)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  if (variants === undefined || variants.members.length < 2) return null

  const { members, index } = variants
  const count = members.length
  const previous = index > 1 ? members[index - 2] : undefined
  const next = index < count ? members[index] : undefined
  const stop = next === undefined ? 0 : 1
  const open = (target: SessionId | undefined): void => {
    if (target !== undefined && target !== sessionId) openSession(target)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    switch (event.key) {
      case 'ArrowLeft': buttons.current[0]?.focus(); break
      case 'ArrowRight': buttons.current[1]?.focus(); break
      case 'Home': open(members[0]); break
      case 'End': open(members.at(-1)); break
      default: return
    }
    event.preventDefault()
  }
  const step = (target: SessionId | undefined, at: 0 | 1, label: string) => (
    <button
      ref={(element) => { buttons.current[at] = element }}
      type="button"
      className={classes(css.action, css.pagerButton)}
      aria-label={label}
      aria-disabled={target === undefined || undefined}
      data-unavailable={target === undefined || undefined}
      tabIndex={at === stop ? 0 : -1}
      onClick={() => { open(target) }}
      onKeyDown={onKeyDown}
    >
      {at === 0 ? <IconChevronLeftOutlineRegular size={14} /> : <IconChevronRightOutlineRegular size={14} />}
    </button>
  )
  return (
    <span className={css.pager} role="group" aria-label={t('pager.aria', { index, count })} data-loom-pager="">
      <span className={css.sep} aria-hidden="true" />
      {step(previous, 0, t('pager.previous'))}
      <span className={css.count} aria-hidden="true">
        <span className={css.countShort}>{t('pager.count', { index, count })}</span>
        <span className={css.countLong}>{t('pager.aria', { index, count })}</span>
      </span>
      {step(next, 1, t('pager.next'))}
    </span>
  )
}
