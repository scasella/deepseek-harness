/**
 * The Branch ×N form in the input dock: one steering line per branch, how
 * many samples to run of each line, the route with an optional override, and
 * where the branches keep their files, and what they would cost. Start sends
 * a `steer` set, or a `variants` set when each line is sampled more than
 * once; nothing runs before Start. Cancel,
 * Escape, and a successful Start return keyboard focus to the control that
 * opened the form: its Branch ×N caret, else the Loom tree's tab stop.
 */
import { useMemo, useRef, type KeyboardEvent } from 'react'
import {
  Button, IconBranchOutlineRegular, IconCloseOutlineRegular, IconPlusOutlineRegular, Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { LoomBranchForm } from './branching.ts'
import { classes } from './classes.ts'
import { CostRow } from './CostRow.tsx'
import { CountChoice } from './CountChoice.tsx'
import type { LoomDockProps } from './dock.ts'
import { failureText, plural, rowsText } from './format.ts'
import { IsolationRow } from './IsolationRow.tsx'
import { projectionValuesOf, sessionTitle } from './lineage.ts'
import { loomEstimateKey } from './reads.ts'
import { inheritedRoute } from './routes.ts'
import { RouteRow } from './RouteRow.tsx'
import panelCss from './panel.module.css'
import css from './Dock.module.css'

/** Samples per line the form offers. */
const SAMPLES = [1, 2, 3, 4] as const

/**
 * Group the one-based positions of rows holding the same non-empty line.
 * @param rows - the steering lines.
 * @returns one group per repeated line, each with two or more positions.
 */
export function duplicateRows(rows: readonly string[]): readonly (readonly number[])[] {
  const groups = new Map<string, number[]>()
  rows.forEach((row, index) => {
    const line = row.trim()
    if (line === '') return
    const group = groups.get(line)
    if (group === undefined) groups.set(line, [index + 1])
    else group.push(index + 1)
  })
  return [...groups.values()].filter(group => group.length > 1)
}

/**
 * Find the control that opened the open form: the Branch ×N caret that shows
 * itself expanded, else the Loom tree's tab stop. Closing the form collapses
 * the caret, so the opener is found before the form closes.
 * @returns the control, or null when the form came from neither.
 */
function openerOf(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-loom-branch-caret][aria-expanded="true"]')
    ?? document.querySelector<HTMLElement>('[data-loom-row][tabindex="0"]')
}

/**
 * Move focus to the opener, unless focus went elsewhere meanwhile.
 * @param opener - the control found by {@link openerOf} while the form was open.
 * @param form - the form's element while it is still mounted; null after it closed.
 */
function returnFocus(opener: HTMLElement | null, form: HTMLElement | null): void {
  const active = document.activeElement
  if (active !== null && active !== document.body && form?.contains(active) !== true) return
  opener?.focus()
}

/**
 * Render the Cost row of an open form. A separate component, so the estimate is read only while the form is open
 * and only when the branch count, the cut, or the kind of set changes; typing a steering line reads nothing.
 * @param props.form - the open form.
 * @param props.count - children the form would create.
 * @param props.useLoomEstimate - estimate hook.
 * @param props.t - Loom translate seat.
 * @returns the `dt`/`dd` pair, or null when the estimate failed.
 */
function FormCost({ form, count, useLoomEstimate, t }: {
  form: LoomBranchForm
  count: number
  useLoomEstimate: LoomDockProps['useLoomEstimate']
  t: LoomDockProps['t']
}) {
  const state = useLoomEstimate(loomEstimateKey({
    sessionId: form.sourceSessionId, kind: form.samples > 1 ? 'variants' : 'steer', afterTurn: form.afterTurn, count,
    ...form.selection === null ? {} : { selection: form.selection },
  }))
  return <CostRow state={state} count={count} t={t} />
}

/**
 * Render the form while one is open for this dock.
 * @param props - the dock's Session, Session list, projections, branching state and verbs, routes, and copy.
 * @returns the form, or null.
 */
export function BranchForm({
  sessionId, useSessions, useProjection, useChat, useLoomBranching, useLoomRoutes, useLoomEstimate, editForm, closeForm,
  submitForm, loadRoutes, t,
}: LoomDockProps) {
  const form = useLoomBranching(state => state.forms[sessionId])
  const list = useSessions(state => state)
  const ownNext = useProjection('modelSelection', value => value?.next ?? undefined)
  const chatLastTurn = useChat(snapshot => snapshot.timeline.turnOrder.at(-1))
  // The route the cut turn's successor started on when Chat holds that turn, else the one the cut turn ended on:
  // a pick made between them belongs to the cut.
  const turnRoute = useChat((snapshot) => {
    if (form === undefined) return undefined
    const tail = (turn: number) => snapshot.nodes.turnDataSource(turn, 'turn-tail').getSnapshot().at(-1)?.tokenUsage?.routes
    return tail(form.afterTurn + 1)?.[0] ?? tail(form.afterTurn)?.at(-1)
  })
  const routes = useLoomRoutes(state => state)
  const element = useRef<HTMLElement | null>(null)
  const rows = form?.rows
  const duplicates = useMemo(() => duplicateRows(rows ?? []), [rows])
  if (form === undefined) return null

  const source = form.sourceSessionId
  const sourceValues = source === sessionId ? undefined : projectionValuesOf(list, source)
  const route = source === sessionId
    ? inheritedRoute({ afterTurn: form.afterTurn, lastTurn: chatLastTurn, next: ownNext, turnRoute })
    : inheritedRoute({
      afterTurn: form.afterTurn,
      lastTurn: sourceValues?.turnOutline?.at(-1)?.turn,
      next: sourceValues?.modelSelection?.next,
      turnRoute: undefined,
    })
  const total = form.rows.length * form.samples
  const blank = form.rows.some(row => row.trim() === '')
  const title = source === sessionId
    ? t('form.title', { turn: form.afterTurn })
    : t('form.titleOf', { turn: form.afterTurn, title: sessionTitle(list, source) })
  const setRow = (index: number, value: string): void => {
    editForm(sessionId, { rows: form.rows.map((row, at) => at === index ? value : row) })
  }
  const cancel = (): void => {
    returnFocus(openerOf(), element.current)
    closeForm(sessionId)
  }
  const start = (): void => {
    const opener = openerOf()
    void submitForm(sessionId).then((started) => { if (started) returnFocus(opener, element.current) })
  }
  // An open route menu has handled Escape and prevented its default; so has a composition ending.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
    event.preventDefault()
    cancel()
  }
  return (
    <div className={css.dock}>
      <section ref={element} className={css.panel} aria-label={title} data-loom-branch-form="" onKeyDown={onKeyDown}>
        <header className={css.header}>
          <IconBranchOutlineRegular size={14} className={css.lead} />
          <span className={css.title}>{title}</span>
          <span className={css.meta}>{t(`tree.branches.${plural(total)}`, { count: total })}</span>
        </header>
        <ol className={css.rows}>
          {form.rows.map((row, index) => (
            <li key={index} className={css.row}>
              <span className={css.index} aria-hidden="true">{index + 1}</span>
              <Input
                className={classes(css.input)}
                value={row}
                aria-label={t('form.row', { index: index + 1 })}
                placeholder={t('form.placeholder')}
                autoFocus={index === 0}
                onChange={(event) => { setRow(index, event.currentTarget.value) }}
              />
              {form.rows.length > 1 && (
                <button
                  type="button"
                  className={css.remove}
                  aria-label={t('form.remove', { index: index + 1 })}
                  onClick={() => { editForm(sessionId, { rows: form.rows.filter((_row, at) => at !== index) }) }}
                >
                  <IconCloseOutlineRegular size={12} />
                </button>
              )}
            </li>
          ))}
        </ol>
        <div className={css.addLine}>
          <button type="button" className={css.add} onClick={() => { editForm(sessionId, { rows: [...form.rows, ''] }) }}>
            <IconPlusOutlineRegular size={12} />
            {t('form.add')}
          </button>
          {duplicates.map(group => (
            <span key={group.join(',')} className={css.note}>{t('form.duplicate', { rows: rowsText(group, t) })}</span>
          ))}
        </div>
        <dl className={classes(panelCss.details, css.details)}>
          <dt>{t('form.samples')}</dt>
          <dd>
            <CountChoice
              values={SAMPLES}
              value={form.samples}
              label={t('form.samples')}
              format={count => t('regen.times', { count })}
              onChange={(samples) => { editForm(sessionId, { samples }) }}
              disabled={form.starting}
            />
          </dd>
          <RouteRow
            route={route}
            selection={form.selection}
            sameLabel={t('route.sameParent')}
            routes={routes}
            loadRoutes={loadRoutes}
            onSelect={(selection) => { editForm(sessionId, { selection }) }}
            t={t}
          />
          <IsolationRow
            value={form.isolation}
            unavailable={form.isolationUnavailable}
            disabled={form.starting}
            onChange={(isolation) => { editForm(sessionId, { isolation }) }}
            t={t}
          />
          <FormCost form={form} count={total} useLoomEstimate={useLoomEstimate} t={t} />
        </dl>
        {form.failure !== null && <p className={css.error} role="alert">{failureText(form.failure, t)}</p>}
        <footer className={css.footer}>
          <span className={css.note}>{t(blank ? 'form.empty' : 'form.nothingRuns')}</span>
          <Button variant="ghost" size="sm" onClick={cancel}>{t('action.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={blank || form.starting} onClick={start}>
            {t(`form.start.${plural(total)}`, { count: total })}
          </Button>
        </footer>
      </section>
    </div>
  )
}
