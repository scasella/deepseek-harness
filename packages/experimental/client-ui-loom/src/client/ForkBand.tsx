/**
 * The fork band at a fork's cut, rendered in Chat's `conversation.chat.fork-cut`
 * seat right after the collapsed inherited row: the parent, the cut, an
 * "Open parent" link, and one chip per variant at the same cut with the
 * current one marked. A subagent child's cut is a delegation, not a branch,
 * so the band renders nothing there.
 */
import { forwardRef, useLayoutEffect, useMemo, useRef } from 'react'
import { classes } from './classes.ts'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { ClippedText, ClippedTooltip, useClipped } from './clipped.tsx'
import { cutReading, type LoomTranslate } from './format.ts'
import { membersWithoutLineage, sessionTitle, variantsOf, type LoomCut } from './lineage.ts'
import type { LoomLinkInjected } from './links.ts'
import type { NS } from './locales.ts'
import { useRefreshOnce } from './refresh.ts'
import css from './ForkBand.module.css'

/** Full props of the fork band. */
export type ForkBandProps =
  PropsRuntime<'conversation.chat.fork-cut'> & InjectFace<LoomLinkInjected> & PropsLocale<typeof NS>

/** Mark which ends of the chip strip hide chips, so the edge fades show only there. */
function markScrollEdges(strip: HTMLElement): void {
  strip.toggleAttribute('data-scroll-start', strip.scrollLeft > 0)
  strip.toggleAttribute('data-scroll-end', strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1)
}

/**
 * Render the fork band at the cut Chat offers.
 * @param props - the cut, standard Session hooks, family hook, navigation, and copy.
 * @returns the band, or null for a subagent child.
 */
export function ForkBand({
  sessionId, parentSession, cutSeq, cutTurn, inheritedTurn, useSessions, useLoomFamily, openSession, refreshProjection, t,
}: ForkBandProps) {
  const list = useSessions(state => state)
  const familyState = useLoomFamily(sessionId)
  const family = familyState?.status === 'ready' ? familyState.family : undefined
  const cut = useMemo<LoomCut>(
    () => ({ parentId: parentSession, cutSeq, ...cutTurn === undefined ? {} : { cutTurn } }),
    [parentSession, cutSeq, cutTurn],
  )
  const variants = useMemo(
    () => family === undefined ? undefined : variantsOf(family, list, sessionId, cut),
    [family, list, sessionId, cut],
  )
  const pending = useMemo(() => family === undefined ? [] : membersWithoutLineage(family, list), [family, list])
  useRefreshOnce(pending, refreshProjection)
  const members = variants?.members ?? [sessionId]
  // Unchanged membership keeps the reveal effect, so a list update never snaps a scrolled chip row back.
  const memberKey = members.join('\n')
  const currentChip = useRef<HTMLButtonElement>(null)
  // The chips scroll in one row; keep the current chip in view, also after the band narrows, by
  // scrolling the strip itself so Chat's scroll position never moves, and fade the clipped ends.
  useLayoutEffect(() => {
    const chip = currentChip.current
    const strip = chip?.parentElement
    if (chip === null || strip == null) return
    const reveal = (): void => {
      const overflow = chip.getBoundingClientRect().right - strip.getBoundingClientRect().right
      if (overflow > 0) strip.scrollLeft += overflow
      markScrollEdges(strip)
    }
    const scrolled = (): void => { markScrollEdges(strip) }
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(strip)
    strip.addEventListener('scroll', scrolled, { passive: true })
    return () => {
      observer.disconnect()
      strip.removeEventListener('scroll', scrolled)
    }
  }, [memberKey])

  if (list.byId[sessionId]?.origin === 'subagent') return null
  const cutText = cutReading(cut.cutTurn, inheritedTurn, t)
  const parentTitle = list.byId[cut.parentId]?.displayTitle
  return (
    <section className={css.band} data-loom-fork-band="">
      <div
        className={css.label}
        role="group"
        aria-label={parentTitle === undefined
          ? t('band.ariaUnlisted', { cut: cutText })
          : t('band.aria', { title: parentTitle, cut: cutText })}
      >
        <IconBranchOutlineRegular size={14} className={css.icon} />
        <span className={css.lead}>{t(parentTitle === undefined ? 'band.branched' : 'band.from')}</span>
        {parentTitle !== undefined && <ClippedText text={parentTitle} className={css.parent} />}
        <span className={css.tail}>
          <span>{cutText}</span>
          {parentTitle !== undefined && (
            <button
              type="button"
              className={css.open}
              aria-label={t('band.openParentAria', { title: parentTitle })}
              onClick={() => { openSession(cut.parentId) }}
            >
              {t('band.openParent')}
            </button>
          )}
        </span>
      </div>
      {members.length > 1 && (
        <div className={css.variants} role="group" aria-label={t('band.variantsAria', { cut: cutText })}>
          <span className={css.caption} aria-hidden="true">{t('band.variants')}</span>
          <div className={css.strip}>
            {members.map((id, index) => (
              <VariantChipButton
                key={id}
                ref={id === sessionId ? currentChip : undefined}
                index={index + 1}
                count={members.length}
                title={sessionTitle(list, id)}
                current={id === sessionId}
                onOpen={() => { openSession(id) }}
                t={t}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

/** One variant chip; its title shows in full in a tooltip while the chip clips it. */
const VariantChipButton = forwardRef<HTMLButtonElement, {
  index: number
  count: number
  title: string
  current: boolean
  onOpen: () => void
  t: LoomTranslate
}>(function VariantChipButton({ index, count, title, current, onOpen, t }, ref) {
  const [titleRef, clipped] = useClipped<HTMLSpanElement>(title)
  return (
    <ClippedTooltip label={title} clipped={clipped}>
      <button
        ref={ref}
        type="button"
        className={classes(css.chip, current && css.chipCurrent)}
        aria-current={current || undefined}
        aria-label={t('band.chipAria', { index, count, title })}
        onClick={current ? undefined : onOpen}
      >
        <span className={css.chipIndex}>{index}</span>
        <span ref={titleRef} className={css.chipTitle}>{title}</span>
      </button>
    </ClippedTooltip>
  )
})
