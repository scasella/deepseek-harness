/**
 * The running-branches strip in a Session's input dock while branch sets it
 * started or branched still run, wait, or failed: counts of running, queued,
 * waiting-for-approval, and failed children, one row per child, and controls
 * to withdraw queued children. A row is named by its steering line or its
 * position, never by its Session title; it opens the child's Session once the
 * child has one. The strip reads a set's status again whenever one of its
 * children starts, ends, or asks for approval while others wait, and
 * {@link POLL_DELAY_MS} after each read while a set waits with no child
 * running; it adopts sets found running in the family after a reload.
 */
import { useEffect, useMemo, useState } from 'react'
import { StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LoomSetId } from '@deepseek-ai/dsh-experimental-loom/types'
import type { LoomFailure } from './branching.ts'
import type { LoomDockProps } from './dock.ts'
import { failureText, type LoomTranslate } from './format.ts'
import type { LoomKey } from './locales.ts'
import { projectionValuesOf } from './lineage.ts'
import { useRefreshOnce } from './refresh.ts'
import { stripOf, type LoomStripItem, type LoomStripStatus } from './strip.ts'
import css from './Dock.module.css'

/** Copy key and dot of each item status. */
const STATUS = {
  'running': { key: 'strip.state.running', dot: 'ongoing' },
  'approval': { key: 'strip.state.approval', dot: 'warning' },
  'done': { key: 'strip.state.done', dot: 'done' },
  'queued': { key: 'strip.state.queued', dot: 'idle' },
  'failed': { key: 'strip.state.failed', dot: 'error' },
  'not-started': { key: 'strip.state.notStarted', dot: 'idle' },
} as const satisfies Record<LoomStripStatus, { key: LoomKey; dot: StateDotState }>

/** Pause before a waiting set with no running child is read again. */
const POLL_DELAY_MS = 2_000

/**
 * Read a waiting set again {@link POLL_DELAY_MS} after each of its status reads.
 * @param props.setId - the set.
 * @param props.pollKey - the set's poll key; a new key schedules the next read.
 * @param props.refreshSet - the read.
 * @returns nothing visible.
 */
function SetPoll({ setId, pollKey, refreshSet }: { setId: LoomSetId; pollKey: string; refreshSet: LoomDockProps['refreshSet'] }) {
  useEffect(() => {
    const timer = setTimeout(() => { refreshSet(setId) }, POLL_DELAY_MS)
    return () => { clearTimeout(timer) }
  }, [setId, pollKey, refreshSet])
  return null
}

/**
 * Visible name of one child: its steering line, else its position. A child's
 * Session title does not tell siblings apart, because steer and variants
 * children inherit the source title and the others keep the fallback title.
 */
function itemLabel(item: LoomStripItem, t: LoomTranslate): string {
  return item.line ?? t('strip.position', { index: item.index + 1 })
}

/**
 * Render the strip while it has children to show.
 * @param props - the dock's Session, list, live status, family, branching state and verbs, and copy.
 * @returns the strip, or null.
 */
export function RunningStrip({
  sessionId, useSessions, useSessionStatus, useLoomFamily, useLoomBranching,
  adoptSet, refreshSet, dismissSet, cancelBranches, openSession, refreshProjection, t,
}: LoomDockProps) {
  const list = useSessions(state => state)
  const statuses = useSessionStatus(value => value)
  const familyState = useLoomFamily(sessionId)
  const family = familyState?.status === 'ready' ? familyState.family : undefined
  const sets = useLoomBranching(state => state.sets)
  const [failure, setFailure] = useState<LoomFailure | null>(null)
  const strip = useMemo(() => stripOf({ sessionId, sets, family, list, statuses }), [sessionId, sets, family, list, statuses])
  const pending = useMemo(() => (family?.nodes ?? [])
    .filter(node => node.parentId !== undefined && projectionValuesOf(list, node.sessionId)?.loomBranch === undefined)
    .map(node => node.sessionId), [family, list])
  useRefreshOnce(pending, refreshProjection)
  const untrackedKey = strip.untracked.map(set => set.setId).join('\n')
  // The key lists exactly the sets to adopt, so the effect runs once per newly found set.
  useEffect(() => {
    for (const set of strip.untracked) adoptSet({ ...set, ownerSessionId: sessionId })
  }, [untrackedKey, sessionId, adoptSet])
  const refreshKey = strip.sets.flatMap(set => set.refreshKey === undefined ? [] : [`${set.setId}=${set.refreshKey}`]).join('\n')
  // The key changes exactly when a waiting set's children change state.
  useEffect(() => {
    for (const set of strip.sets) if (set.refreshKey !== undefined) refreshSet(set.setId)
  }, [refreshKey, refreshSet])
  if (strip.sets.length === 0) return null

  const { counts } = strip
  const summary = [
    counts.running > 0 ? t('strip.running', { count: counts.running }) : undefined,
    counts.approval > 0 ? t('strip.approval', { count: counts.approval }) : undefined,
    counts.queued > 0 ? t('strip.queued', { count: counts.queued }) : undefined,
    counts.failed > 0 ? t('strip.failed', { count: counts.failed }) : undefined,
  ].filter(part => part !== undefined).join(t('sep'))
  const cancel = (setId: Parameters<typeof cancelBranches>[0], indices?: readonly number[]): void => {
    setFailure(null)
    void cancelBranches(setId, indices).then((outcome) => {
      if (!outcome.ok) setFailure(outcome.failure)
    })
  }
  return (
    <div className={css.dock}>
      <section className={css.panel} aria-label={t('strip.aria')} data-loom-strip="">
        <header className={css.header}>
          <StateDot state={counts.running > 0 ? 'ongoing' : counts.approval > 0 ? 'warning' : 'idle'} />
          <span className={css.title} role="status">{summary}</span>
          {counts.queued > 0 && (
            <button
              type="button"
              className={css.link}
              onClick={() => { for (const set of strip.sets) if (set.items.some(item => item.status === 'queued')) cancel(set.setId) }}
            >
              {t('strip.cancelQueued')}
            </button>
          )}
        </header>
        <ul className={css.items}>
          {strip.sets.flatMap(set => set.items.map((item) => {
            const label = itemLabel(item, t)
            const child = item.sessionId
            const status = STATUS[item.status]
            const state = item.code === undefined ? t(status.key) : `${t(status.key)}${t('sep')}${failureText({ code: item.code, unknownOutcome: false }, t)}`
            return (
              <li key={`${set.setId}:${String(item.index)}`} className={css.item} data-loom-strip-item={item.status}>
                <StateDot state={status.dot} />
                {child === undefined
                  ? <span className={css.itemLabel}>{label}</span>
                  : (
                    <button type="button" className={css.itemOpen} aria-label={t('strip.open', { title: label })} onClick={() => { openSession(child) }}>
                      {label}
                    </button>
                  )}
                <span className={css.itemState}>{state}</span>
                {item.status === 'queued' && (
                  <button type="button" className={css.link} aria-label={t('strip.cancelOne', { label })} onClick={() => { cancel(set.setId, [item.index]) }}>
                    {t('action.cancel')}
                  </button>
                )}
              </li>
            )
          }))}
        </ul>
        {strip.sets.filter(set => !set.active).map(set => (
          <div key={set.setId} className={css.footer}>
            <button type="button" className={css.link} onClick={() => { dismissSet(set.setId) }}>{t('strip.dismiss')}</button>
          </div>
        ))}
        {failure !== null && <p className={css.error} role="alert">{failureText(failure, t)}</p>}
        {strip.sets.map(set => set.pollKey === undefined
          ? null
          : <SetPoll key={set.setId} setId={set.setId} pollKey={set.pollKey} refreshSet={refreshSet} />)}
      </section>
    </div>
  )
}
