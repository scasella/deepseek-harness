/**
 * Header chip of a fork with sibling variants: "Variant k of N · after turn T",
 * opening a menu that switches to another variant at the same cut. Variants
 * are numbered by creation time, then Session id.
 */
import { useMemo, useState } from 'react'
import { IconBranchOutlineRegular, IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { cutReading } from './format.ts'
import { membersWithoutLineage, openedTurnAt, projectionValuesOf, sessionTitle, variantsOf } from './lineage.ts'
import type { LoomLinkInjected } from './links.ts'
import type { NS } from './locales.ts'
import { useRefreshOnce } from './refresh.ts'
import { useLoomMobile } from './mobile.ts'
import { VariantSheet } from './VariantSheet.tsx'
import css from './VariantChip.module.css'

/** Full props of the header variant chip. */
export type VariantChipProps =
  PropsRuntime<'conversation.session.header.actions'> & InjectFace<LoomLinkInjected> & PropsLocale<typeof NS>

/**
 * Render the variant chip, or nothing for a Session with fewer than two variants at its cut.
 * @param props - standard Session hooks, family hook, navigation, and copy.
 * @returns the chip.
 */
export function VariantChip({ sessionId, useSessions, useLoomFamily, openSession, refreshProjection, t }: VariantChipProps) {
  const list = useSessions(state => state)
  const familyState = useLoomFamily(sessionId)
  const family = familyState?.status === 'ready' ? familyState.family : undefined
  const variants = useMemo(() => family === undefined ? undefined : variantsOf(family, list, sessionId), [family, list, sessionId])
  const pending = useMemo(() => {
    if (family === undefined) return []
    const ids = membersWithoutLineage(family, list)
    // The parent's outline names the turn a cut inside a turn falls in.
    const parent = variants !== undefined && variants.members.length > 1 ? variants.parentId : undefined
    return parent === undefined || projectionValuesOf(list, parent)?.turnOutline !== undefined ? ids : [...ids, parent]
  }, [family, list, variants])
  const [open, setOpen] = useState(false)
  const mobile = useLoomMobile()
  useRefreshOnce(pending, refreshProjection)
  if (variants === undefined || variants.members.length < 2) return null

  const cutText = cutReading(variants.cutTurn, openedTurnAt(projectionValuesOf(list, variants.parentId), variants.cutSeq), t)
  const count = variants.members.length
  if (mobile) return (
    <span className={css.root}>
      <button type="button" className={css.chip} aria-haspopup="dialog" aria-expanded={open}
        aria-label={t('chip.aria', { index: variants.index, count, cut: cutText })}
        onClick={() => { setOpen(value => !value) }}>
        <IconBranchOutlineRegular size={14} />
        <span>{t('chip.variant', { index: variants.index, count })}</span>
      </button>
      <VariantSheet open={open} close={() => { setOpen(false) }} members={variants.members} current={sessionId}
        parent={variants.parentId} list={list} cut={cutText} select={openSession} t={t} />
    </span>
  )
  return (
    <span className={css.root}>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        selectedId={sessionId}
        onSelect={(id) => {
          setOpen(false)
          if (id !== sessionId) openSession(SessionId(id))
        }}
        items={variants.members.map((id, index) => ({
          id,
          label: t('chip.menuItem', { index: index + 1, title: sessionTitle(list, id) }),
        }))}
        anchor={(
          <button
            type="button"
            className={css.chip}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={t('chip.aria', { index: variants.index, count, cut: cutText })}
            onClick={() => { setOpen(value => !value) }}
          >
            <IconBranchOutlineRegular size={14} />
            <span>{t('chip.variant', { index: variants.index, count })}</span>
            <span className={css.cut}><span className={css.sep}>{t('sep')}</span>{cutText}</span>
            <IconChevronDownOutlineRegular size={10} className={css.caret} />
          </button>
        )}
      />
    </span>
  )
}
