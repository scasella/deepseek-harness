/**
 * Detail of the branch picked in Compare: its diff in a `DiffBlock`, one tab
 * per changed file, and what the user can do with the branch. Adopt makes the
 * branch the main line; the Host archives its siblings, never deletes them.
 * Apply diff to folder writes a worktree branch's change into the source
 * folder after a confirmation that names the files, and the Host refuses a
 * folder with changes in the way. Continue here opens the branch in Chat.
 * Discard worktree removes a worktree the Loom service created. Apply and
 * Discard wait for a running branch to finish, and exist only for worktrees.
 */
import { useMemo, useRef, useState } from 'react'
import { Button, DiffBlock, type DiffBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { LOOM_UNAVAILABLE, type LoomFailure, type LoomValueOutcome } from './branching.ts'
import { classes } from './classes.ts'
import { failureText, plural, type LoomTranslate } from './format.ts'
import { loomDiffKey } from './reads.ts'
import type { LoomViewProps } from './LoomView.tsx'
import type { LoomCompareRow } from '@deepseek-ai/dsh-experimental-loom/types'
import { parseUnifiedDiff } from './unified-diff.ts'
import css from './CompareDetail.module.css'

/** Lines of the diff shown before the middle folds. */
const DIFF_MAX_LINES = 40

/** Props the Compare table hands its detail. */
export interface CompareDetailProps extends Pick<LoomViewProps,
  'useLoomDiff' | 'adoptBranch' | 'applyBranch' | 'discardBranch' | 'openSession'> {
  /** The picked branch. */
  readonly row: LoomCompareRow
  /** Number of branches in the comparison, the picked one included. */
  readonly branches: number
  /** Called after an action changed the branches, so the comparison reads again. */
  readonly onChanged: () => void
  readonly t: LoomTranslate
}

/** What the last action did, for its status line. */
type DetailResult =
  | { readonly kind: 'adopt'; readonly archived: number }
  | { readonly kind: 'apply'; readonly files: number }
  | { readonly kind: 'discard' }

/**
 * Build the diff card's chrome labels.
 * @param t - Loom translate seat.
 * @returns the labels.
 */
function diffLabels(t: LoomTranslate): DiffBlockLabels {
  return {
    codeLabel: t('codeBlock.title'),
    wrapLabel: t('codeBlock.wrap'),
    unwrapLabel: t('codeBlock.unwrap'),
    copy: t('copy'),
    copied: t('copied'),
    collapseAria: t('diff.collapseAria'),
    expandAria: count => t('diff.expandAria', { count }),
    collapse: t('collapse'),
    expand: count => t('diff.expandRest', { count }),
  }
}

/**
 * Render the picked branch's diff and actions.
 * @param props - the branch, the diff hook, the verbs, and copy.
 * @returns the detail.
 */
export function CompareDetail({
  row, branches, useLoomDiff, adoptBranch, applyBranch, discardBranch, openSession, onChanged, t,
}: CompareDetailProps) {
  const [path, setPath] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'apply' | 'discard' | null>(null)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<DetailResult | null>(null)
  const [failure, setFailure] = useState<LoomFailure | null>(null)
  const applyButton = useRef<HTMLButtonElement>(null)
  const discardButton = useRef<HTMLButtonElement>(null)
  const files = row.diff?.files ?? []
  const worktreeEnded = row.worktreeEnded === true || result?.kind === 'apply' || result?.kind === 'discard'
  const worktree = row.isolation === 'worktree' && !worktreeEnded
  const busy = pending || row.running

  const run = async <Value,>(call: () => Promise<LoomValueOutcome<Value>>, done: (value: Value) => DetailResult): Promise<void> => {
    setPending(true)
    setFailure(null)
    setResult(null)
    setConfirm(null)
    const outcome = await call()
    setPending(false)
    if (outcome.ok) setResult(done(outcome.value))
    else setFailure(outcome.failure)
    // A refused or half-done action can still have changed the branches, so the comparison reads again either way.
    onChanged()
  }
  const dismiss = (): void => {
    const trigger = confirm === 'apply' ? applyButton.current : discardButton.current
    setConfirm(null)
    trigger?.focus()
  }
  const others = branches - 1
  const title = row.title === '' ? t('compare.untitled') : row.title
  return (
    <section className={css.detail} aria-label={t('detail.aria', { title })} data-loom-detail="">
      <div className={css.actions}>
        <Button
          variant="primary"
          size="md"
          disabled={row.adopted || pending}
          onClick={() => { void run(() => adoptBranch(row.sessionId), value => ({ kind: 'adopt', archived: value.archived.length })) }}
        >
          {t(row.adopted ? 'action.adopted' : 'action.adopt')}
        </Button>
        <p className={css.hint}>{t(others === 1 ? 'adopt.noteOne' : others > 0 ? 'adopt.note' : 'adopt.noteAlone', { count: others })}</p>
        {worktree && (
          <>
            <Button
              ref={applyButton}
              variant="outline"
              size="md"
              disabled={busy || files.length === 0}
              aria-expanded={confirm === 'apply'}
              onClick={() => { setConfirm('apply') }}
            >
              {t('action.apply')}
            </Button>
            <p className={css.hint}>
              {row.running
                ? t('detail.running')
                : files.length === 0 ? t('apply.noFiles') : t(`apply.note.${plural(files.length)}`, { count: files.length })}
            </p>
          </>
        )}
        <Button variant="outline" size="md" onClick={() => { openSession(row.sessionId) }}>{t('action.continue')}</Button>
        <p className={css.hint}>{t('continue.note')}</p>
        {worktree
          ? (
            <button
              ref={discardButton}
              type="button"
              className={css.link}
              disabled={busy}
              aria-expanded={confirm === 'discard'}
              onClick={() => { setConfirm('discard') }}
            >
              {t('action.discard')}
            </button>
          )
          : <p className={css.hint}>{t(row.isolation === 'worktree' ? 'detail.worktreeUnavailable' : 'detail.shared')}</p>}
      </div>
      <div className={css.diff}>
        {!worktreeEnded && files.length > 1 && (
          <div role="group" aria-label={t('detail.filesAria')} className={css.files}>
            <FileTab pressed={path === null} onPress={() => { setPath(null) }} label={t('detail.allFiles')} />
            {files.map(file => (
              <FileTab
                key={file.path}
                pressed={path === file.path}
                onPress={() => { setPath(file.path) }}
                label={file.path}
                added={t('compare.diff.added', { count: file.insertions })}
                removed={file.deletions === 0 ? undefined : t('compare.diff.removed', { count: file.deletions })}
              />
            ))}
          </div>
        )}
        {row.isolation === 'worktree' && !worktree
          ? <p className={css.status}>{t('detail.worktreeUnavailable')}</p>
          : <DiffPane row={row} path={path} useLoomDiff={useLoomDiff} t={t} />}
      </div>
      {confirm === 'apply' && (
        <Confirm
          label={t('apply.confirmAria')}
          text={t(`apply.confirm.${plural(files.length)}`, { count: files.length })}
          items={files.map(file => file.path)}
          submit={t('apply.submit')}
          onSubmit={() => { void run(() => applyBranch(row.sessionId), value => ({ kind: 'apply', files: value.applied.length })) }}
          onDismiss={dismiss}
          t={t}
        />
      )}
      {confirm === 'discard' && (
        <Confirm
          label={t('discard.confirmAria')}
          text={t('discard.confirm')}
          items={[]}
          submit={t('discard.submit')}
          onSubmit={() => { void run(() => discardBranch(row.sessionId), () => ({ kind: 'discard' })) }}
          onDismiss={dismiss}
          t={t}
        />
      )}
      {result !== null && <p className={css.result} role="status">{resultText(result, t)}</p>}
      {failure !== null && <p className={css.error} role="alert">{failureText(failure, t)}</p>}
    </section>
  )
}

/**
 * The confirmation an action that writes or removes files asks for: what it does, the files it names, and Cancel,
 * which has the focus, beside the action's own button. Escape dismisses it.
 * @param props - copy, the files named, and the callbacks.
 * @returns the confirmation group.
 */
function Confirm({ label, text, items, submit, onSubmit, onDismiss, t }: {
  label: string
  text: string
  items: readonly string[]
  submit: string
  onSubmit: () => void
  onDismiss: () => void
  t: LoomTranslate
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={css.confirm}
      onKeyDown={(event) => { if (event.key === 'Escape') onDismiss() }}
    >
      <p className={css.confirmText}>{text}</p>
      {items.length > 0 && (
        <ul className={css.confirmFiles}>
          {items.map(item => <li key={item}>{item}</li>)}
        </ul>
      )}
      <div className={css.confirmButtons}>
        <Button variant="ghost" size="sm" autoFocus onClick={onDismiss}>{t('action.cancel')}</Button>
        <Button variant="primary" size="sm" onClick={onSubmit}>{submit}</Button>
      </div>
    </div>
  )
}

/**
 * Name what an action did.
 * @param result - the action's result.
 * @param t - Loom translate seat.
 * @returns the status line.
 */
function resultText(result: DetailResult, t: LoomTranslate): string {
  switch (result.kind) {
    case 'adopt': return result.archived === 0 ? t('adopt.doneAlone') : t(`adopt.done.${plural(result.archived)}`, { count: result.archived })
    case 'apply': return t(`apply.done.${plural(result.files)}`, { count: result.files })
    case 'discard': return t('discard.done')
  }
}

/** One file tab: a toggle that shows that file's diff. */
function FileTab({ pressed, label, added, removed, onPress }: {
  pressed: boolean
  label: string
  added?: string
  removed?: string | undefined
  onPress: () => void
}) {
  return (
    <button type="button" className={classes(css.file, pressed && css.filePressed)} aria-pressed={pressed} onClick={onPress}>
      <span className={css.filePath}>{label}</span>
      {added !== undefined && <span className={css.added}>{added}</span>}
      {removed !== undefined && <span className={css.removed}>{removed}</span>}
    </button>
  )
}

/** The diff of the picked branch or of one of its files. */
function DiffPane({ row, path, useLoomDiff, t }: Pick<CompareDetailProps, 'row' | 'useLoomDiff' | 't'> & { path: string | null }) {
  const version = row.diff === undefined
    ? ''
    : [row.diff.insertions, row.diff.deletions, row.diff.files.length].join(':')
  const state = useLoomDiff(loomDiffKey(row.sessionId, path, version))
  const labels = useMemo(() => diffLabels(t), [t])
  const parsed = useMemo(() => state?.status === 'ready' ? parseUnifiedDiff(state.value.unified) : undefined, [state])
  if (state === undefined || state.status === 'loading') return <p className={css.status} role="status">{t('detail.diffLoading')}</p>
  if (state.status === 'failed') {
    return (
      <p className={css.error} role="alert">
        {failureText({ code: state.code ?? LOOM_UNAVAILABLE, unknownOutcome: false }, t)}
      </p>
    )
  }
  return (
    <>
      {parsed !== undefined && parsed.hunks.length > 0
        ? <DiffBlock diffs={parsed.hunks} labels={labels} maxLines={DIFF_MAX_LINES} />
        : <p className={css.status}>{t('detail.diffEmpty')}</p>}
      {parsed !== undefined && parsed.binary.length > 0 && (
        <p className={css.status}>{t('detail.binary', { paths: parsed.binary.join(t('form.rowsSep')) })}</p>
      )}
      {state.value.truncated && <p className={css.status}>{t('detail.truncated')}</p>}
    </>
  )
}
