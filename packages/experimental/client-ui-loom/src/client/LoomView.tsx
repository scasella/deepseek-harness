/**
 * The Loom view tab. Read mode shows the fork family's outline tree beside a
 * reading pane that shows the selected Session's path as one document; while
 * the panes sit side by side, the floating composer spans only the reading
 * pane, and stacked at narrow widths it spans the whole tab. Compare mode
 * shows the comparison of the branches at one cut across the whole tab.
 */
import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {
  InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { CompareView } from './CompareView.tsx'
import type { LoomBranchingInjected } from './links.ts'
import type { NS } from './locales.ts'
import { LoomTree } from './LoomTree.tsx'
import { ReadingPane } from './ReadingPane.tsx'
import type { LoomReaderState } from './reader.ts'
import type { LoomReadState } from './read-sources.ts'
import type { LoomRequestState } from './requests.ts'
import type { LoomCompareValue, LoomDiffValue } from '@deepseek-ai/dsh-experimental-loom/types'
import type { createLoomViewStore, LoomViewMode } from './view-store.ts'
import type { LoomWorkspace } from './workspace.ts'
import css from './LoomView.module.css'
import { WeaveView } from './WeaveView.tsx'
import type { LoomProseInjected } from './prose.ts'

/** `conversation.view` entry id of the Loom tab; a view request addressed to it names a Session to read. */
export const LOOM_VIEW_ID = 'loom'

/** Sources and callbacks the Loom view receives. */
export interface LoomViewInjected extends LoomBranchingInjected, Omit<LoomProseInjected, 'keyedHooks'> {
  readonly keyedHooks: LoomBranchingInjected['keyedHooks'] & LoomProseInjected['keyedHooks'] & {
    /** Path documents keyed by Session id, bound as `useLoomReader(sessionId)`. */
    readonly loomReader: (key: string) => ObservableSnapshot<LoomReaderState>
    /** Request views keyed by `<sessionId>:<seq>`, bound as `useLoomRequest(key)`. */
    readonly loomRequest: (key: string) => ObservableSnapshot<LoomRequestState>
    /** Comparisons keyed by {@link loomCompareKey}, bound as `useLoomCompare(key)`. */
    readonly loomCompare: (key: string) => ObservableSnapshot<LoomReadState<LoomCompareValue>>
    /** Branch diffs keyed by {@link loomDiffKey}, bound as `useLoomDiff(key)`. */
    readonly loomDiff: (key: string) => ObservableSnapshot<LoomReadState<LoomDiffValue>>
  }
  /**
   * Read a comparison again.
   * @param sessionId - the Session the comparison was read for.
   */
  readonly refreshCompare: (sessionId: SessionId) => void
  /** Adopt a branch; see {@link LoomWorkspace.adopt}. */
  readonly adoptBranch: LoomWorkspace['adopt']
  /** Apply a worktree branch's change to the source folder; see {@link LoomWorkspace.apply}. */
  readonly applyBranch: LoomWorkspace['apply']
  /** Discard a branch's worktree; see {@link LoomWorkspace.discard}. */
  readonly discardBranch: LoomWorkspace['discard']
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
  const mode = useStore(state => state.mode)
  const modeId = useId()
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
  // Compare has no reading pane, so its composer spans the tab.
  useLayoutEffect(() => {
    const view = root.current
    const read = readPane.current
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
  }, [insetComposerStart, mode])
  const loading = (
    <p className={css.status} role="status">
      {t(familyState?.status === 'unlisted' ? 'family.unavailable' : 'family.loading')}
    </p>
  )
  const panel = (value: LoomViewMode) => ({
    role: 'tabpanel',
    id: `${modeId}-${value}-panel`,
    'aria-labelledby': `${modeId}-${value}`,
  })
  return (
    <div ref={root} className={css.root} data-conversation-composer-overlay="" data-loom-view="">
      <div className={css.toolbar}>
        <SegmentedControl<LoomViewMode>
          id={modeId}
          label={t('mode.aria')}
          value={mode}
          options={[{ value: 'read', label: t('mode.read') }, { value: 'compare', label: t('mode.compare') }, { value: 'weave', label: t('mode.weave') }]}
          onChange={actions.mode}
        />
      </div>
      {mode === 'read'
        ? (
          <div className={css.panes} {...panel('read')}>
            <section className={css.treePane}>
              {family === undefined
                ? loading
                : <LoomTree {...props} family={family} currentSessionId={sessionId} selectedSessionId={selected} />}
            </section>
            <section ref={readPane} className={css.readPane} aria-label={t('read.aria')}>
              {family !== undefined && <ReadingPane {...props} family={family} sessionId={selected} currentSessionId={sessionId} />}
            </section>
          </div>
        )
        : mode === 'compare' ? (
          <div className={css.comparePane} {...panel('compare')}>
            {family === undefined ? loading : <CompareView {...props} family={family} selectedSessionId={selected} />}
          </div>
        ) : <div className={css.weavePane} {...panel('weave')}><WeaveView {...props} /></div>}
    </div>
  )
}
