/** Touch-accessible sibling navigation; every title and action remains visible without hover. */
import { BottomSheet, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { sessionTitle } from './lineage.ts'
import type { VariantChipProps } from './VariantChip.tsx'
import css from './VariantSheet.module.css'

/**
 * Render a sibling chooser at the bottom of the viewport.
 * @param props - visible siblings, current selection, localized labels, and navigation callbacks.
 * @returns the shared bottom sheet.
 */
export function VariantSheet({ open, close, members, current, parent, list, cut, select, t }: {
  open: boolean
  close: () => void
  members: readonly SessionId[]
  current: SessionId
  parent: SessionId
  list: SessionListState
  cut: string
  select: (sessionId: SessionId) => void
  t: VariantChipProps['t']
}) {
  return (
    <BottomSheet open={open} onClose={close} title={t('mobile.variants', { cut })} closeLabel={t('mobile.close')}>
      <button className={css.source} type="button" onClick={() => { select(parent); close() }}>
        <span>{t('mobile.source', { title: sessionTitle(list, parent) })}</span>
        <IconChevronRightOutlineRegular size={14} />
      </button>
      <ol className={css.list}>
        {members.map((id, index) => (
          <li key={id}>
            <button type="button" className={css.row} aria-current={id === current ? 'true' : undefined}
              onClick={() => { select(id); close() }}>
              <span className={css.index}>{index + 1}</span>
              <span className={css.title}>{sessionTitle(list, id)}</span>
              <IconChevronRightOutlineRegular size={14} />
            </button>
          </li>
        ))}
      </ol>
    </BottomSheet>
  )
}
