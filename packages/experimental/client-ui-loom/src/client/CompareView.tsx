/**
 * Compare mode of the Loom tab: one row per branch forked at a cut, with what
 * each branch did (tests from its own command output, files and lines
 * changed), what it used (steps, own cost, wall time), whether it runs, and
 * the private marks. The table never ranks rows and shows no "best" badge;
 * it says which branches report the same test outcome. A radio picks a row,
 * and the picked row expands to its diff and actions. The table reads
 * `loom.compare` when it opens and again whenever a branch at the cut starts
 * or ends, so a running branch's numbers catch up without a timer.
 */
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { IconChevronDownOutlineRegular, Menu, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { LoomCompareRow, LoomFamily, LoomMark } from '@deepseek-ai/dsh-experimental-loom/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LOOM_UNAVAILABLE } from './branching.ts'
import { branchPoints, defaultPoint, type LoomBranchPoint } from './compare-points.ts'
import { compareTable, type LoomCompareTable, type LoomTableRow } from './compare-table.ts'
import { CompareDetail } from './CompareDetail.tsx'
import { classes } from './classes.ts'
import { ClippedText } from './clipped.tsx'
import {
  compactTokens, durationText, failureText, listText, plural, pointReading, usdText, type LoomTranslate,
} from './format.ts'
import { KeepGlyph, SetAsideGlyph } from './glyphs.tsx'
import { markOf, membersWithoutLineage, projectionValuesOf, sessionTitle } from './lineage.ts'
import { loomCompareKey } from './reads.ts'
import { useRefreshOnce } from './refresh.ts'
import type { LoomViewProps } from './LoomView.tsx'
import type { createLoomViewStore } from './view-store.ts'
import css from './CompareView.module.css'

/** Props the view hands its Compare mode. */
export interface CompareViewProps extends Pick<LoomViewProps,
  'useSessions' | 'useSessionStatus' | 'useLoomCompare' | 'useLoomDiff' | 'useLoomBranching' | 'setMark' | 'openSession'
  | 'refreshProjection' | 'refreshCompare' | 'adoptBranch' | 'applyBranch' | 'discardBranch'>,
  PropsStore<ReturnType<typeof createLoomViewStore>> {
  readonly family: LoomFamily
  /** Session the reading pane would show; Compare opens on the branch point it belongs to. */
  readonly selectedSessionId: SessionId
  readonly t: LoomTranslate
}

/** Copy key of each mark. */
const MARKS = [
  { mark: 'keep', label: 'marks.keep', glyph: <KeepGlyph size={14} /> },
  { mark: 'set-aside', label: 'marks.setAside', glyph: <SetAsideGlyph size={14} /> },
] as const satisfies readonly { mark: LoomMark; label: string; glyph: ReactNode }[]

/**
 * Render the Compare mode.
 * @param props - family, selected Session, hooks, store, verbs, and copy.
 * @returns the comparison of the selected branch point, or the reason there is none.
 */
export function CompareView(props: CompareViewProps) {
  const { family, selectedSessionId, useSessions, useStore, refreshProjection, t } = props
  const list = useSessions(state => state)
  const pointId = useStore(state => state.point)
  const points = useMemo(() => branchPoints(family, list), [family, list])
  const missing = useMemo(() => membersWithoutLineage(family, list), [family, list])
  useRefreshOnce(missing, refreshProjection)
  const point = points.find(candidate => candidate.id === pointId) ?? defaultPoint(points, list, selectedSessionId)
  const representative = point?.children[0]
  if (point === undefined || representative === undefined) return <p className={css.status}>{t('compare.empty')}</p>
  return <CompareBody key={point.id} {...props} list={list} points={points} point={point} representative={representative} />
}

/** Props of the comparison of one branch point. */
interface CompareBodyProps extends CompareViewProps {
  readonly list: SessionListState
  readonly points: readonly LoomBranchPoint[]
  readonly point: LoomBranchPoint
  /** Child whose cut names the siblings. */
  readonly representative: SessionId
}

/** The comparison of one branch point. */
function CompareBody({
  list, points, point, representative, useSessionStatus, useLoomCompare, useLoomDiff, useLoomBranching, useStore, actions,
  setMark, openSession, refreshCompare, adoptBranch, applyBranch, discardBranch, t,
}: CompareBodyProps) {
  const state = useLoomCompare(loomCompareKey(representative))
  const statuses = useSessionStatus(value => value)
  const marks = useLoomBranching(snapshot => snapshot.marks)
  const picked = useStore(snapshot => snapshot.picked)
  const group = useId()
  const [menuOpen, setMenuOpen] = useState(false)
  // A branch that starts or ends changes what the table shows; the first key is the state the first read already saw.
  const liveKey = point.children
    .map(id => `${id}:${(statuses.get(id)?.running ?? list.byId[id]?.running) === true ? 'running' : 'idle'}`)
    .join(',')
  const seen = useRef(liveKey)
  useEffect(() => {
    if (seen.current === liveKey) return
    seen.current = liveKey
    refreshCompare(representative)
  }, [liveKey, representative, refreshCompare])
  const table = useMemo<LoomCompareTable | undefined>(() => {
    if (state?.status !== 'ready') return undefined
    // The projection or a save in flight knows a mark before the Host's row does.
    return compareTable(state.value.rows, (row) => {
      const projected = projectionValuesOf(list, row.sessionId)?.loomMark
      const override = marks[row.sessionId]
      return projected === undefined && override === undefined ? row.mark ?? null : markOf(projected, override)
    }, t('compare.untitled'))
  }, [state, list, marks, t])
  const label = [
    pointReading(point.cutTurn, point.openedTurn, t),
    sessionTitle(list, point.parentSessionId),
    t(`tree.branches.${plural(point.children.length)}`, { count: point.children.length }),
  ].join(t('sep'))
  const markFailure = Object.values(marks).find(mark => mark.status === 'failed')
  const pickedRow = table?.rows.find(entry => entry.row.sessionId === picked)
  return (
    <div className={css.compare} data-loom-compare="" aria-busy={state?.status === 'ready' && state.refreshing}>
      <div className={css.bar}>
        {points.length > 1
          ? (
            <Menu
              portal
              listClassName={css.pointMenu}
              open={menuOpen}
              onClose={() => { setMenuOpen(false) }}
              selectedId={point.id}
              onSelect={(id) => {
                setMenuOpen(false)
                actions.pointed(id)
              }}
              items={points.map(candidate => ({
                id: candidate.id,
                label: [
                  pointReading(candidate.cutTurn, candidate.openedTurn, t),
                  sessionTitle(list, candidate.parentSessionId),
                  t(`tree.branches.${plural(candidate.children.length)}`, { count: candidate.children.length }),
                ].join(t('sep')),
              }))}
              anchor={(
                <button
                  type="button"
                  className={css.pointButton}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label={t('compare.pointAria', { point: label })}
                  onClick={() => { setMenuOpen(open => !open) }}
                >
                  <span className={css.pointText}>{label}</span>
                  <IconChevronDownOutlineRegular size={12} />
                </button>
              )}
            />
          )
          : <span className={css.pointText}>{label}</span>}
        {table !== undefined && <span className={css.runNote}>{t(`compare.run.${table.isolation}`)}</span>}
      </div>
      {state === undefined || state.status === 'loading'
        ? <p className={css.status} role="status">{t('compare.loading')}</p>
        : state.status === 'failed'
          ? <p className={css.status} role="alert">{failureText({ code: state.code ?? LOOM_UNAVAILABLE, unknownOutcome: false }, t)}</p>
          : (
            <>
              {state.stale && <p className={css.status} role="status">{t('compare.stale')}</p>}
              {table !== undefined && (
                <CompareTable
                  table={table}
                  group={group}
                  picked={pickedRow?.row.sessionId ?? null}
                  onPick={(sessionId) => { actions.picked(sessionId) }}
                  setMark={setMark}
                  detail={entry => (
                    <CompareDetail
                      row={entry.row}
                      branches={table.rows.length}
                      useLoomDiff={useLoomDiff}
                      adoptBranch={adoptBranch}
                      applyBranch={applyBranch}
                      discardBranch={discardBranch}
                      openSession={openSession}
                      onChanged={() => { refreshCompare(representative) }}
                      t={t}
                    />
                  )}
                  t={t}
                />
              )}
              {markFailure?.status === 'failed' && <p className={css.status} role="status">{failureText(markFailure.failure, t)}</p>}
            </>
          )}
    </div>
  )
}

/** Props of the table. */
interface CompareTableProps {
  readonly table: LoomCompareTable
  /** Name of the radio group. */
  readonly group: string
  readonly picked: SessionId | null
  readonly onPick: (sessionId: SessionId) => void
  readonly setMark: CompareViewProps['setMark']
  /** Render the detail of the picked row. */
  readonly detail: (entry: LoomTableRow) => ReactNode
  readonly t: LoomTranslate
}

/** The rows, their outcome notes, and the picked row's detail. */
function CompareTable({ table, group, picked, onPick, setMark, detail, t }: CompareTableProps) {
  const columns = [
    ['branch', 'compare.col.branch'], ['tests', 'compare.col.tests'], ['diff', 'compare.col.diff'], ['steps', 'compare.col.steps'],
    ['cost', table.priced ? 'compare.col.costPriced' : 'compare.col.costTokens'], ['wall', 'compare.col.wall'], ['marks', 'compare.col.marks'],
  ] as const
  return (
    <>
      <div role="table" aria-label={t('compare.aria')} className={css.table}>
        <div role="rowgroup">
          <div role="row" className={classes(css.row, css.head)}>
            <div role="columnheader" className={css.pick}><span className={css.hidden}>{t('compare.col.pick')}</span></div>
            {columns.map(([name, key]) => <div key={name} role="columnheader" className={css[name]}>{t(key)}</div>)}
          </div>
        </div>
        <div role="rowgroup">
          {table.rows.map((entry) => {
            const { row } = entry
            return (
              <Fragment key={row.sessionId}>
                <RowView entry={entry} group={group} picked={picked === row.sessionId} onPick={onPick} setMark={setMark} t={t} />
                {picked === row.sessionId && (
                  <div role="row" className={css.detailRow}>
                    <div role="cell" className={css.detailCell}>{detail(entry)}</div>
                  </div>
                )}
              </Fragment>
            )
          })}
        </div>
      </div>
      {table.groups.map(same => (
        <p key={same.labels.join('\u0000')} className={css.note}>
          {t(same.diffsDiffer ? 'compare.sameDiffer' : 'compare.same', { labels: listText(same.labels, t) })}
        </p>
      ))}
    </>
  )
}

/** One row of the table. */
function RowView({ entry, group, picked, onPick, setMark, t }: {
  entry: LoomTableRow
  group: string
  picked: boolean
  onPick: (sessionId: SessionId) => void
  setMark: CompareViewProps['setMark']
  t: LoomTranslate
}) {
  const { row, mark, grouped } = entry
  const title = row.title === '' ? t('compare.untitled') : row.title
  const id = useId()
  const total = row.own.inputTokens + row.own.cachedTokens + row.own.outputTokens
  return (
    <div role="row" className={classes(css.row, picked && css.picked)} data-loom-compare-row={row.sessionId} data-picked={picked}>
      <div role="cell" className={css.pick}>
        <input
          id={`${id}-pick`}
          type="radio"
          name={group}
          className={css.radio}
          checked={picked}
          aria-label={title}
          onChange={() => { onPick(row.sessionId) }}
        />
      </div>
      <div role="cell" className={css.branch}>
        <label htmlFor={`${id}-pick`} className={css.branchLabel}>
          <ClippedText text={title} className={css.title} />
          <ClippedText text={row.prompt} className={css.prompt} />
        </label>
        <span className={css.tags}>
          {row.running && <Tag tone="info">{t('compare.running')}</Tag>}
          {row.adopted && <Tag tone="success">{t('compare.adopted')}</Tag>}
          {row.isolation === 'worktree' && <Tag tone="neutral">{t('compare.worktree')}</Tag>}
        </span>
      </div>
      <Cell name="tests" label={t('compare.col.tests')}>
        {row.tests === undefined
          ? <span className={css.muted}>{t('compare.tests.none')}</span>
          : (
            <span title={t('compare.tests.from', { command: row.tests.command })} className={css.testResult}>
              <StateDot state={row.tests.ok ? 'done' : 'error'} size={8} />
              {row.tests.ok
                ? t('compare.tests.ok', { passed: row.tests.passed })
                : t('compare.tests.failed', { failed: row.tests.failed, total: row.tests.total })}
              {grouped && <span className={css.same} title={t('compare.sameOutcome')}><span aria-hidden="true">{t('compare.sameMark')}</span></span>}
            </span>
          )}
      </Cell>
      <Cell name="diff" label={t('compare.col.diff')}>
        <DiffSummary row={row} t={t} />
      </Cell>
      <Cell name="steps" label={t('compare.col.steps')}>{row.own.steps}</Cell>
      <Cell name="cost" label={t(row.own.usd === undefined ? 'compare.col.costTokens' : 'compare.col.costPriced')}>
        {row.own.usd === undefined
          ? t('tree.tokens', { value: compactTokens(total, t) })
          : usdText(row.own.usd.amount, t)}
      </Cell>
      <Cell name="wall" label={t('compare.col.wall')}>
        {row.wallMs === undefined ? t('compare.none') : durationText(row.wallMs, t)}
      </Cell>
      <div role="cell" className={css.marks}>
        {MARKS.map(entry => (
          <button
            key={entry.mark}
            type="button"
            className={classes(css.mark, mark === entry.mark && css.markOn)}
            aria-pressed={mark === entry.mark}
            aria-label={t('compare.markAria', { mark: t(entry.label), title })}
            title={t(entry.label)}
            onClick={() => { void setMark(row.sessionId, mark === entry.mark ? null : entry.mark) }}
          >
            {entry.glyph}
            <span className={css.markLabel}>{t(entry.label)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** One metric cell; its label shows only where the table stacks into cards. */
function Cell({ name, label, children }: { name: 'tests' | 'diff' | 'steps' | 'cost' | 'wall'; label: string; children: ReactNode }) {
  return (
    <div role="cell" className={css[name]}>
      <span className={css.cellLabel} aria-hidden="true">{label}</span>
      <span className={css.cellValue}>{children}</span>
    </div>
  )
}

/** Lines and files a branch changed. */
function DiffSummary({ row, t }: { row: LoomCompareRow; t: LoomTranslate }) {
  const { diff } = row
  if (diff === undefined) return <span className={css.muted}>{t('compare.none')}</span>
  if (diff.files.length === 0) return <span className={css.muted}>{t('compare.diff.none')}</span>
  return (
    <>
      <span className={css.lines}>
        {diff.insertions > 0 && <span className={css.added}>{t('compare.diff.added', { count: diff.insertions })}</span>}
        {diff.deletions > 0 && <span className={css.removed}>{t('compare.diff.removed', { count: diff.deletions })}</span>}
      </span>
      <span className={css.files}>{t(`compare.diff.files.${plural(diff.files.length)}`, { count: diff.files.length })}</span>
    </>
  )
}
