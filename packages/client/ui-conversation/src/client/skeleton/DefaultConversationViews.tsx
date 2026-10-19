import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { ConversationSessionSlotProps } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import { resolveActiveView } from '../view-selection.ts'
import css from './ConversationRoot.module.css'

/** Scrollport variable the overlay composer seat reads as its inline-start offset. */
const COMPOSER_INSET_PROPERTY = '--dsh-composer-inset-start'

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft persisted while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function DefaultConversationViews({
  view, useSession, useConversation, useConversationViews, inputActions, useStore, actions,
  renderSlot, bindDraftPersistence, openView, useInspectCall,
}: ConversationSessionSlotProps) {
  const tabs = useConversationViews(value => value)
  const inspectCall = useInspectCall(value => value)
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const viewRequest = useStore(s => s.viewRequest ?? null)
  const area = useRef<HTMLDivElement>(null)
  // The composer seat and the View share the scrollport, so the inset rides a variable on it. The
  // written scrollport is kept, so a reset still reaches it after the view area has unmounted.
  const insetTarget = useRef<HTMLElement | null>(null)
  const insetComposerStart = useCallback((pixels: number) => {
    const scroller = insetTarget.current ?? area.current?.closest<HTMLElement>('[data-conversation-scroll]') ?? null
    if (scroller === null) return
    if (pixels > 0) {
      scroller.style.setProperty(COMPOSER_INSET_PROPERTY, `${pixels}px`)
      insetTarget.current = scroller
    } else {
      scroller.style.removeProperty(COMPOSER_INSET_PROPERTY)
      insetTarget.current = null
    }
  }, [])

  useEffect(() => {
    const unbindDraftPersistence = bindDraftPersistence(actions.setDraft)
    inputActions.persistDraft()
    return () => { unbindDraftPersistence() }
    // The Session input owns content before this persistence writer is attached.
  }, [inputActions])

  const blank = session.blank && conversationPhase(session, conversation) === 'blank'
  const viewId = blank ? undefined : view ?? active?.id
  // A View's inset never outlives it: the cleanup runs before the next View's layout effects.
  useLayoutEffect(() => () => { insetComposerStart(0) }, [viewId, insetComposerStart])

  if (blank) return null
  return (
    <div ref={area} className={css.viewArea}>
      {viewId !== undefined && renderSlot('conversation.view', {
        inspectCall,
        viewRequest,
        openView,
        completeViewRequest: actions.completeViewRequest,
        insetComposerStart,
      }, { only: viewId })}
    </div>
  )
}
