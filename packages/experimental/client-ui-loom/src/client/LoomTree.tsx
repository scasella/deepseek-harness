/**
 * APG outline tree of one fork family. Rows are a flat list carrying
 * `aria-level`, `aria-posinset`, and `aria-setsize`; one row holds the tab
 * stop. Up/Down move, Home/End jump, Right expands or enters, Left collapses
 * or climbs, and Enter or Space reads a Session or toggles a branch point.
 * The keys act only while a row has focus. The disclosure chevron is a
 * pointer target only; the row itself carries the expanded state.
 */
import { useMemo, useRef, type KeyboardEvent } from 'react'
import { classes } from './classes.ts'
import {
  IconBranchOutlineRegular, IconChevronRightOutlineRegular, StateDot, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { LoomFamily, LoomMark } from '@deepseek-ai/dsh-experimental-loom/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { compactTokens, failureText, plural, pointReading, type LoomTranslate } from './format.ts'
import { KeepGlyph, SetAsideGlyph } from './glyphs.tsx'
import { projectionValuesOf } from './lineage.ts'
import { useRefreshOnce } from './refresh.ts'
import { buildLoomTree, sessionRowId, type LoomRowStatus, type LoomTreeRow } from './tree.ts'
import type { LoomViewProps } from './LoomView.tsx'
import { VariantTallies } from './VariantTallies.tsx'
import type { createLoomViewStore } from './view-store.ts'
import css from './LoomTree.module.css'

/** Props the view hands its tree. */
export interface LoomTreeProps extends Pick<LoomViewProps,
  'useSessions' | 'useSessionStatus' | 'refreshProjection' | 'useLoomBranching' | 'openForm' | 'setMark'>,
  PropsStore<ReturnType<typeof createLoomViewStore>> {
  readonly family: LoomFamily
  /** Session the Loom tab belongs to. */
  readonly currentSessionId: SessionId
  /** Session the reading pane shows. */
  readonly selectedSessionId: SessionId
  readonly t: LoomTranslate
}

/** Indentation of one tree level, in CSS pixels. */
const LEVEL_INDENT = 19
/** Distance from a row's start to its disclosure chevron's centre, where its children's guide runs. */
const GUIDE_OFFSET = 15

function dotState(status: LoomRowStatus): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'done': return 'done'
    case 'blank': return 'idle'
    /* v8 ignore next -- closed-union backstop; the compiler rejects a new status here. */
    default: return assertNever(status)
  }
}

/** Point label naming the cut by the turn it falls in or after. */
function pointLabel(row: Extract<LoomTreeRow, { kind: 'point' }>, t: LoomTranslate): string {
  return row.cutSeq === undefined ? t('tree.pointUnknown') : pointReading(row.cutTurn, row.openedTurn, t)
}

/**
 * Guide lines of one row, drawn left of its box: a full line for each outer
 * level whose path continues, the elbow joining the row to its parent, and
 * the stem under an expanded row's own chevron.
 */
function Guides({ row }: { row: LoomTreeRow }) {
  const own = row.rails.length - 1
  return (
    <span aria-hidden="true">
      {row.rails.map((continues, index) => {
        const left = GUIDE_OFFSET - (row.rails.length - index) * LEVEL_INDENT
        if (index === own) {
          return <span key={index} className={classes(css.elbow, continues && css.elbowThrough)} style={{ left }} />
        }
        return continues ? <span key={index} className={css.rail} style={{ left }} /> : null
      })}
      {row.expandable && row.expanded && <span className={css.stem} style={{ left: GUIDE_OFFSET }} />}
    </span>
  )
}

/** Copy key naming a row's mark. */
const MARK_NAMES = { keep: 'tree.mark.keep', 'set-aside': 'tree.mark.setAside' } as const satisfies Record<LoomMark, string>

/** Visible label and accessible name of one row. */
function rowText(row: LoomTreeRow, t: LoomTranslate): { label: string; summary: string; metric: string | undefined; name: string } {
  const sep = t('list.sep')
  if (row.kind === 'point') {
    const label = pointLabel(row, t)
    const summary = t(`tree.branches.${plural(row.branchCount)}`, { count: row.branchCount })
    const metric = row.tokens === undefined ? undefined : t('tree.tokensTotal', { value: compactTokens(row.tokens, t) })
    const running = row.running === 0 ? undefined : t('tree.running', { count: row.running })
    return { label, summary, metric, name: [label, summary, metric, running].filter(part => part !== undefined).join(sep) }
  }
  const summary = [
    row.turns === undefined ? undefined : t(`tree.turns.${plural(row.turns)}`, { count: row.turns }),
    row.steps === undefined ? undefined : t(`tree.steps.${plural(row.steps)}`, { count: row.steps }),
  ].filter(part => part !== undefined).join(t('sep'))
  const metric = row.tokens === undefined ? undefined : t('tree.tokens', { value: compactTokens(row.tokens, t) })
  const name = [
    row.title, summary === '' ? undefined : summary,
    metric === undefined ? undefined : t('tree.ownTokens', { value: metric }),
    t(`tree.status.${row.status}`),
    row.mark === null ? undefined : t(MARK_NAMES[row.mark]),
    row.adopted ? t('tree.adopted') : undefined,
  ].filter(part => part !== undefined).join(sep)
  return { label: row.title, summary, metric, name }
}

/**
 * Render the family tree with its key hints.
 * @param props - family, current and selected Sessions, hooks, view store, and copy.
 * @returns the tree.
 */
export function LoomTree({
  family, currentSessionId, selectedSessionId, useSessions, useSessionStatus, refreshProjection, useLoomBranching,
  openForm, setMark, useStore, actions, t,
}: LoomTreeProps) {
  const list = useSessions(state => state)
  const statuses = useSessionStatus(value => value)
  const marks = useLoomBranching(state => state.marks)
  const collapsedIds = useStore(state => state.collapsed)
  const activeId = useStore(state => state.active)
  const tree = useMemo(() => buildLoomTree({
    family, list, currentSessionId,
    running: id => statuses.get(id)?.running,
    collapsed: new Set(collapsedIds),
    marks,
  }), [family, list, currentSessionId, statuses, collapsedIds, marks])
  const markFailure = family.nodes.map(node => marks[node.sessionId]).find(mark => mark?.status === 'failed')
  const missing = useMemo(() => {
    // A parent's outline names the turn a cut inside a turn falls in.
    const parents = new Set(family.nodes.map(node => node.parentId))
    return family.nodes.filter((node) => {
      const values = projectionValuesOf(list, node.sessionId)
      return values?.sessionStats === undefined || values.tokenUsage === undefined
        || (node.parentId !== undefined && values.forkLineage === undefined)
        || (parents.has(node.id) && values.turnOutline === undefined)
    }).map(node => node.sessionId)
  }, [family, list])
  useRefreshOnce(missing, refreshProjection)
  const rowElements = useRef(new Map<string, HTMLDivElement>())

  const rows = tree.rows
  const selectedRowId = sessionRowId(selectedSessionId)
  const stop = rows.find(row => row.id === activeId)?.id
    ?? rows.find(row => row.id === selectedRowId)?.id
    ?? rows[0]?.id

  const focusRow = (row: LoomTreeRow | undefined): void => {
    if (row === undefined) return
    actions.activated(row.id)
    rowElements.current.get(row.id)?.focus()
  }
  const activate = (row: LoomTreeRow): void => {
    if (row.kind === 'point') actions.toggled(row.id)
    else actions.selected(row.sessionId)
  }
  // g branches a Session after its last ended turn, or a branch point at its cut; a cut inside a turn has no turn to keep.
  const branch = (row: LoomTreeRow): void => {
    if (row.kind === 'point') {
      if (row.cutTurn !== undefined && (row.openedTurn ?? 0) <= row.cutTurn) {
        openForm(currentSessionId, { sourceSessionId: row.parentSessionId, afterTurn: row.cutTurn })
      }
      return
    }
    const afterTurn = (row.lastTurn ?? 0) - (row.status === 'running' ? 1 : 0)
    if (afterTurn >= 1) openForm(currentSessionId, { sourceSessionId: row.sessionId, afterTurn })
  }
  const mark = (row: LoomTreeRow, value: LoomMark): void => {
    if (row.kind === 'session') void setMark(row.sessionId, row.mark === value ? null : value)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: LoomTreeRow, index: number): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    switch (event.key) {
      case 'ArrowDown': focusRow(rows[index + 1]); break
      case 'ArrowUp': focusRow(rows[index - 1]); break
      case 'Home': focusRow(rows[0]); break
      case 'End': focusRow(rows.at(-1)); break
      case 'ArrowRight':
        if (!row.expandable) break
        if (row.expanded) focusRow(rows[index + 1])
        else actions.toggled(row.id)
        break
      case 'ArrowLeft':
        if (row.expandable && row.expanded) actions.toggled(row.id)
        else focusRow(rows.find(candidate => candidate.id === row.parentRowId))
        break
      case 'Enter':
      case ' ':
        activate(row)
        break
      case 'g': branch(row); break
      case 'k': mark(row, 'keep'); break
      case 'x': mark(row, 'set-aside'); break
      default: return
    }
    event.preventDefault()
  }

  return (
    <div className={css.root}>
      <p className={css.heading}>
        {[t('tree.heading'), t(`tree.sessions.${plural(tree.sessionCount)}`, { count: tree.sessionCount }), t('tree.ownUsage')].join(t('sep'))}
      </p>
      <div role="tree" aria-label={t('tree.aria')} className={css.tree}>
        {rows.map((row, index) => {
          const text = rowText(row, t)
          const selected = row.kind === 'session' && row.sessionId === selectedSessionId
          return (
            <div
              key={row.id}
              ref={(element) => {
                if (element === null) rowElements.current.delete(row.id)
                else rowElements.current.set(row.id, element)
              }}
              role="treeitem"
              data-loom-row={row.id}
              tabIndex={row.id === stop ? 0 : -1}
              aria-level={row.level}
              aria-posinset={row.posinset}
              aria-setsize={row.setsize}
              aria-label={text.name}
              {...row.expandable ? { 'aria-expanded': row.expanded } : {}}
              {...row.kind === 'session' ? { 'aria-selected': selected } : {}}
              aria-current={row.kind === 'session' && row.current ? 'true' : undefined}
              className={classes(css.row, row.onPath && css.onPath, selected && css.selected, row.kind === 'point' && css.point)}
              style={{ marginLeft: (row.level - 1) * LEVEL_INDENT }}
              onClick={() => { focusRow(row); activate(row) }}
              onKeyDown={(event) => { onKeyDown(event, row, index) }}
            >
              <Guides row={row} />
              {row.expandable && (
                <span
                  aria-hidden="true"
                  data-loom-disclosure=""
                  className={classes(css.disclosure, row.expanded && css.disclosureOpen)}
                  onClick={(event) => {
                    // The chevron toggles a Session row without reading it; the row keeps focus and the tab stop.
                    event.stopPropagation()
                    focusRow(row)
                    actions.toggled(row.id)
                  }}
                >
                  <IconChevronRightOutlineRegular size={12} />
                </span>
              )}
              <span className={css.mark}>
                {row.kind === 'point' ? <IconBranchOutlineRegular size={12} /> : <StateDot state={dotState(row.status)} />}
              </span>
              <span className={css.content}>
                <span className={css.label}>{text.label}</span>
                {text.summary !== '' && <span className={css.summary}>{text.summary}</span>}
              </span>
              {row.kind === 'session' && row.mark !== null && (
                <span className={css.markGlyph} aria-hidden="true">
                  {row.mark === 'keep' ? <KeepGlyph size={12} /> : <SetAsideGlyph size={12} />}
                </span>
              )}
              {row.kind === 'session' && row.adopted && <span className={css.badge} aria-hidden="true">{t('tree.adopted')}</span>}
              {row.kind === 'point' && row.running > 0 && (
                <span className={css.badge} aria-hidden="true">{t('tree.running', { count: row.running })}</span>
              )}
              {text.metric !== undefined && <span className={css.metric}>{text.metric}</span>}
            </div>
          )
        })}
      </div>
      <VariantTallies family={family} useSessions={useSessions} useLoomBranching={useLoomBranching} t={t} />
      <div className={css.hints}>
        <span className={css.hint}><kbd>↑</kbd><kbd>↓</kbd>{t('keys.move')}</span>
        <span className={css.hint}><kbd>←</kbd><kbd>→</kbd>{t('keys.collapseExpand')}</span>
        <span className={css.hint}><kbd>{t('keys.enter')}</kbd>{t('keys.open')}</span>
        <span className={css.hint}><kbd>{t('keys.capBranch')}</kbd>{t('keys.branch')}</span>
        <span className={css.hint}><kbd>{t('keys.capKeep')}</kbd>{t('keys.keep')}</span>
        <span className={css.hint}><kbd>{t('keys.capSetAside')}</kbd>{t('keys.setAside')}</span>
        <p className={css.note}>{t('keys.note')}</p>
        {markFailure?.status === 'failed' && <p className={css.note} role="status">{failureText(markFailure.failure, t)}</p>}
      </div>
    </div>
  )
}
