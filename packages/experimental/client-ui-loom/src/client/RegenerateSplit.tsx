/**
 * Regenerate split button on a completed Turn opened by a user prompt. The
 * main part regenerates the Turn once as a new branch of this Session; the
 * caret opens a panel to regenerate it ×1, ×2, or ×4, showing the prompt it
 * resends, the route with an optional override, the shared folder, and this
 * Turn's own tokens and cache share. Both parts start a `regenerate` branch set.
 */
import { useState } from 'react'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import {
  Button, IconChevronDownOutlineRegular, IconRefreshOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { LoomFailure } from './branching.ts'
import { classes } from './classes.ts'
import { ClippedText } from './clipped.tsx'
import { CountChoice } from './CountChoice.tsx'
import { cachePercent, compactTokens, failureText } from './format.ts'
import { useHoverCapable } from './hover.ts'
import { LoomPanel, useAnchoredPanel } from './panel.tsx'
import { RouteRow } from './RouteRow.tsx'
import type { LoomTailProps } from './tail.ts'
import panelCss from './panel.module.css'
import css from './TailActions.module.css'

/** Variant counts the panel offers. */
const COUNTS = [1, 2, 4] as const

/**
 * Render the split button and its panel.
 * @param props - the Turn, Chat, projections, branching verbs, routes, and copy.
 * @returns the split button, or null for a Turn that cannot be regenerated.
 */
export function RegenerateSplit(props: LoomTailProps) {
  const { sessionId, turn, turnEndSeq, useAccess, useChat, useProjection, useLoomRoutes, startBranches, loadRoutes, t } = props
  const allowed = useAccess('loom/branch')
  const opening = useChat(snapshot => snapshot.nodes.turnDataSource(turn.turn, 'user').getSnapshot()[0])
  const usage = useChat(snapshot => snapshot.nodes.turnDataSource(turn.turn, 'turn-tail').getSnapshot().at(-1)?.tokenUsage)
  const lastUsed = useProjection('modelSelection', value => value?.lastUsed ?? undefined)
  const latest = useChat(snapshot => snapshot.timeline.turnOrder.at(-1) === turn.turn)
  const routes = useLoomRoutes(state => state)
  const hover = useHoverCapable()
  const panel = useAnchoredPanel('top')
  const [count, setCount] = useState<number>(1)
  const [selection, setSelection] = useState<ModelSelection | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<LoomFailure | null>(null)
  if (!allowed || turnEndSeq === undefined || opening === undefined) return null

  const prompt = opening.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ')
  // The children inherit the route the turn's first request used; only the latest turn can fall back to the Session's last route.
  const route = usage?.routes?.[0] ?? (latest ? lastUsed : undefined)
  // A start from the panel returns focus to the caret; one from the main part leaves focus where it is.
  const regenerate = (times: number, fromPanel: boolean): void => {
    setPending(true)
    setFailure(null)
    void startBranches({
      kind: 'regenerate', sessionId, turn: turn.turn, count: times, ...selection === null ? {} : { selection },
    }, { ownerSessionId: sessionId }).then((outcome) => {
      setPending(false)
      if (!outcome.ok) setFailure(outcome.failure)
      else if (fromPanel) panel.close()
      else panel.setOpen(false)
    })
  }
  const percent = usage?.cacheReadTokens === undefined
    ? undefined
    : cachePercent(usage.cacheReadTokens, usage.totalTokens - usage.outputTokens)
  return (
    <>
      <span ref={panel.anchorRef} className={css.split} data-loom-regenerate="">
        <span className={css.sep} aria-hidden="true" />
        <Tooltip label={t('regen.once')} side="bottom" disabled={!hover}>
          <button
            type="button"
            className={css.pill}
            aria-label={t('regen.once')}
            disabled={pending}
            onClick={() => { regenerate(1, false) }}
          >
            <IconRefreshOutlineRegular />
            <span className={css.label}>{t('regen.label')}</span>
          </button>
        </Tooltip>
        <Tooltip label={t('regen.several')} side="bottom" disabled={!hover || panel.open}>
          <button
            type="button"
            className={classes(css.action, css.caret, panel.open && css.open)}
            aria-label={t('regen.several')}
            aria-haspopup="dialog"
            aria-expanded={panel.open}
            onClick={() => {
              setFailure(null)
              panel.setOpen(!panel.open)
            }}
          >
            <IconChevronDownOutlineRegular size={12} />
          </button>
        </Tooltip>
        {failure !== null && !panel.open && <span className={css.status} role="status">{failureText(failure, t)}</span>}
      </span>
      <LoomPanel panel={panel} label={t('regen.title', { turn: turn.turn })}>
        <p className={panelCss.title}><IconRefreshOutlineRegular />{t('regen.title', { turn: turn.turn })}</p>
        <div className={panelCss.rule} aria-hidden="true" />
        <dl className={panelCss.details}>
          <dt>{t('regen.count')}</dt>
          <dd>
            <CountChoice
              values={COUNTS}
              value={count}
              label={t('regen.countAria')}
              format={times => t('regen.times', { count: times })}
              onChange={setCount}
              disabled={pending}
            />
          </dd>
          <dt>{t('regen.prompt')}</dt>
          <ClippedText as="dd" text={prompt} className={panelCss.oneLine} />
          <RouteRow
            route={route}
            selection={selection}
            sameLabel={t('route.sameBranch')}
            routes={routes}
            loadRoutes={loadRoutes}
            onSelect={setSelection}
            t={t}
          />
          <dt>{t('workspace.title')}</dt>
          <dd>{t('workspace.shared')}</dd>
          {usage !== undefined && (
            <>
              <dt>{t('usage.title')}</dt>
              <dd>
                {percent === undefined
                  ? t('usage.tokens', { tokens: compactTokens(usage.totalTokens, t) })
                  : t('usage.tokensCached', { tokens: compactTokens(usage.totalTokens, t), percent })}
                <span className={panelCss.second}>{t('usage.note')}</span>
              </dd>
            </>
          )}
        </dl>
        {failure !== null && <p className={panelCss.error} role="alert">{failureText(failure, t)}</p>}
        <div className={panelCss.footer}>
          <Button variant="primary" size="sm" disabled={pending} onClick={() => { regenerate(count, true) }}>
            {t('regen.submit', { count })}
          </Button>
        </div>
      </LoomPanel>
    </>
  )
}
