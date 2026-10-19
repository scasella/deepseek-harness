/**
 * Regenerate split button on a completed Turn opened by a user prompt. The
 * main part regenerates the Turn once as a new branch of this Session; the
 * caret opens a panel to regenerate it ×1, ×2, or ×4, showing the prompt it
 * resends, the route with an optional override, where the branches keep their
 * files, and what they would cost. The main part leaves the folder choice to
 * the Host's default; the panel sends its choice. Both parts start a
 * `regenerate` branch set.
 */
import { useState } from 'react'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import {
  Button, IconChevronDownOutlineRegular, IconRefreshOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { LoomFailure } from './branching.ts'
import { classes } from './classes.ts'
import { ClippedText } from './clipped.tsx'
import { CostRow } from './CostRow.tsx'
import { CountChoice } from './CountChoice.tsx'
import { cachePercent, compactTokens, failureText } from './format.ts'
import { useHoverCapable } from './hover.ts'
import { IsolationRow } from './IsolationRow.tsx'
import { LoomPanel, useAnchoredPanel } from './panel.tsx'
import { loomEstimateKey } from './reads.ts'
import { RouteRow } from './RouteRow.tsx'
import type { LoomTailProps } from './tail.ts'
import type { LoomIsolation, LoomIsolationUnavailableReason } from '@deepseek-ai/dsh-experimental-loom/types'
import panelCss from './panel.module.css'
import css from './TailActions.module.css'

/** Variant counts the panel offers. */
const COUNTS = [1, 2, 4] as const

/**
 * Render the panel's Cost row, or the turn's own usage when no estimate can be read. A separate component, so the
 * estimate is read only while the panel is open and only when the turn or the variant count changes.
 * @param props - the Session, turn, count, own usage, route override, hook, and copy.
 * @returns the `dt`/`dd` pair.
 */
function RegenerateCost({ sessionId, turn, count, usage, selection, useLoomEstimate, t }: {
  sessionId: LoomTailProps['sessionId']
  turn: number
  count: number
  usage: ReturnType<typeof ownUsage>
  selection: ModelSelection | null
  useLoomEstimate: LoomTailProps['useLoomEstimate']
  t: LoomTailProps['t']
}) {
  const state = useLoomEstimate(loomEstimateKey({ sessionId, kind: 'regenerate', turn, count,
    ...selection === null ? {} : { selection } }))
  if (state?.status !== 'failed') return <CostRow state={state} count={count} t={t} />
  if (usage === undefined) return null
  return (
    <>
      <dt>{t('usage.title')}</dt>
      <dd>
        {usage.percent === undefined
          ? t('usage.tokens', { tokens: compactTokens(usage.total, t) })
          : t('usage.tokensCached', { tokens: compactTokens(usage.total, t), percent: usage.percent })}
        <span className={panelCss.second}>{t('usage.note')}</span>
      </dd>
    </>
  )
}

/**
 * Read the turn's own usage for the fallback row.
 * @param usage - the Turn tail's token usage.
 * @returns the total tokens and the cache-hit percent, or undefined without usage.
 */
function ownUsage(usage: { totalTokens: number; outputTokens: number; cacheReadTokens?: number } | undefined) {
  if (usage === undefined) return undefined
  return {
    total: usage.totalTokens,
    percent: usage.cacheReadTokens === undefined ? undefined : cachePercent(usage.cacheReadTokens, usage.totalTokens - usage.outputTokens),
  }
}

/**
 * Render the split button and its panel.
 * @param props - the Turn, Chat, projections, branching verbs, routes, and copy.
 * @returns the split button, or null for a Turn that cannot be regenerated.
 */
export function RegenerateSplit(props: LoomTailProps) {
  const {
    sessionId, turn, turnEndSeq, useAccess, useChat, useProjection, useLoomRoutes, useLoomEstimate, startBranches, loadRoutes, t,
  } = props
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
  const [isolation, setIsolation] = useState<LoomIsolation>('shared')
  const [refused, setRefused] = useState<LoomIsolationUnavailableReason | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<LoomFailure | null>(null)
  if (!allowed || turnEndSeq === undefined || opening === undefined) return null

  const prompt = opening.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ')
  // The children inherit the route the turn's first request used; only the latest turn can fall back to the Session's last route.
  const route = usage?.routes?.[0] ?? (latest ? lastUsed : undefined)
  // A start from the panel returns focus to the caret; one from the main part leaves focus where it is
  // and takes the Host's default folder choice.
  const regenerate = (times: number, fromPanel: boolean): void => {
    setPending(true)
    setFailure(null)
    void startBranches({
      kind: 'regenerate',
      sessionId,
      turn: turn.turn,
      count: times,
      ...fromPanel ? { isolation } : {},
      ...selection === null ? {} : { selection },
    }, { ownerSessionId: sessionId }).then((outcome) => {
      setPending(false)
      if (!outcome.ok) {
        setFailure(outcome.failure)
        // A refused isolation is a fact of this Session's folder, so the panel falls back to the shared folder.
        if (outcome.failure.isolationReason !== undefined) {
          setRefused(outcome.failure.isolationReason)
          setIsolation('shared')
        }
      } else if (fromPanel) panel.close()
      else panel.setOpen(false)
    })
  }
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
              // Each opening tries worktrees again, because the folder may have changed since a refusal.
              if (!panel.open) setRefused(null)
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
          <IsolationRow value={isolation} unavailable={refused} disabled={pending} onChange={setIsolation} t={t} />
          <RegenerateCost
            sessionId={sessionId}
            turn={turn.turn}
            count={count}
            usage={ownUsage(usage)}
            selection={selection}
            useLoomEstimate={useLoomEstimate}
            t={t}
          />
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
