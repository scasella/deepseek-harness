/**
 * The Loom view tab in Read mode: the fork family's outline tree beside a
 * reading pane that shows the selected Session's path as one document. While
 * the panes sit side by side, the floating composer spans only the reading
 * pane; stacked at narrow widths, it spans the whole tab.
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {
  InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LoomFamilyState } from './family.ts'
import type { LoomBranchingInjected } from './links.ts'
import type { NS } from './locales.ts'
import { LoomTree } from './LoomTree.tsx'
import { ReadingPane } from './ReadingPane.tsx'
import type { LoomReaderState } from './reader.ts'
import type { LoomRequestState } from './requests.ts'
import type { createLoomViewStore } from './view-store.ts'
import css from './LoomView.module.css'

/** `conversation.view` entry id of the Loom tab; a view request addressed to it names a Session to read. */
export const LOOM_VIEW_ID = 'loom'

/** Sources and callbacks the Loom view receives. */
export interface LoomViewInjected extends LoomBranchingInjected {
  readonly keyedHooks: {
    readonly loomFamily: (key: string) => ObservableSnapshot<LoomFamilyState>
    /** Path documents keyed by Session id, bound as `useLoomReader(sessionId)`. */
    readonly loomReader: (key: string) => ObservableSnapshot<LoomReaderState>
    /** Request views keyed by `<sessionId>:<seq>`, bound as `useLoomRequest(key)`. */
    readonly loomRequest: (key: string) => ObservableSnapshot<LoomRequestState>
  }
  /**
   * Page older history of a read Session into its window.
   * @param sessionId - Session being read.
   */
  readonly loadOlder: (sessionId: SessionId) => void
}

/** Full props of the Loom view. */
export type LoomViewProps =
  PropsRuntime<'conversation.view'>
  & PropsRenderFactories
  & PropsStore<ReturnType<typeof createLoomViewStore>>
  & InjectFace<LoomViewInjected>
  & PropsLocale<typeof NS>

/**
 * Render the Loom tab of one Session.
 * @param props - view owner props, hooks, store, factories, injected sources, and copy.
 * @returns the tab body.
 */
export function LoomView(props: LoomViewProps) {
  const { sessionId, useLoomFamily, useStore, actions, viewRequest, completeViewRequest, insetComposerStart, t } = props
  const familyState = useLoomFamily(sessionId)
  const chosen = useStore(state => state.selected)
  const family = familyState?.status === 'ready' ? familyState.family : undefined
  const selected = family !== undefined && chosen !== null && family.nodes.some(node => node.sessionId === chosen) ? chosen : sessionId
  const requested = viewRequest?.view === LOOM_VIEW_ID ? viewRequest.focus : null
  const settled = familyState?.status === 'ready' || familyState?.status === 'unlisted'
  // A request names a family member to read; it is acknowledged once the family settles, read or not.
  useEffect(() => {
    if (requested === null || !settled) return
    if (family?.nodes.some(node => node.sessionId === requested) === true) actions.selected(SessionId(requested))
    completeViewRequest()
  }, [requested, settled, family, actions, completeViewRequest])
  const root = useRef<HTMLDivElement>(null)
  const readPane = useRef<HTMLElement>(null)
  // The composer starts where the reading pane starts: beside the tree that is the tree's width, stacked it is zero.
  useLayoutEffect(() => {
    const view = root.current
    const read = readPane.current
    /* v8 ignore next -- both panes render unconditionally. */
    if (view === null || read === null) return undefined
    const measure = (): void => {
      insetComposerStart(Math.max(0, read.getBoundingClientRect().left - view.getBoundingClientRect().left))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(view)
    observer.observe(read)
    return () => {
      observer.disconnect()
      insetComposerStart(0)
    }
  }, [insetComposerStart])
  return (
    <div ref={root} className={css.root} data-conversation-composer-overlay="" data-loom-view="">
      <div className={css.panes}>
        <section className={css.treePane}>
          {family === undefined
            ? (
              <p className={css.status} role="status">
                {t(familyState?.status === 'unlisted' ? 'family.unavailable' : 'family.loading')}
              </p>
            )
            : <LoomTree {...props} family={family} currentSessionId={sessionId} selectedSessionId={selected} />}
        </section>
        <section ref={readPane} className={css.readPane} aria-label={t('read.aria')}>
          {family !== undefined && <ReadingPane {...props} family={family} sessionId={selected} currentSessionId={sessionId} />}
        </section>
      </div>
    </div>
  )
}
