/**
 * Edit & branch under the user message that opened a Turn: a panel with the
 * message's text in an inline editor. Enter or Branch forks this Session
 * before the message and sends the edited text, keeping its images and files;
 * the new branch opens once it starts. This Session stays unchanged.
 */
import { useState } from 'react'
import { Button, IconEditOutlineRegular, InlineEditor, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { LoomFailure } from './branching.ts'
import { classes } from './classes.ts'
import { failureText } from './format.ts'
import { useHoverCapable } from './hover.ts'
import type { LoomBranchingInjected } from './links.ts'
import type { NS } from './locales.ts'
import { LoomPanel, useAnchoredPanel } from './panel.tsx'
import panelCss from './panel.module.css'
import css from './TailActions.module.css'

/** Full props of the Edit & branch entry. */
export type EditBranchProps =
  PropsRuntime<'conversation.chat.user-actions'> & InjectFace<LoomBranchingInjected> & PropsLocale<typeof NS>

/**
 * Render the Edit & branch action and its panel.
 * @param props - the message, access, branching verbs, and copy.
 * @returns the action, or null for a message that did not open its Turn.
 */
export function EditBranch({ sessionId, turn, text, hasAttachments, opensTurn, useAccess, startBranches, t }: EditBranchProps) {
  const allowed = useAccess('loom/branch')
  const hover = useHoverCapable()
  const panel = useAnchoredPanel('bottom')
  const [draft, setDraft] = useState(text)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<LoomFailure | null>(null)
  const [empty, setEmpty] = useState(false)
  if (!allowed || !opensTurn) return null

  const submit = (): void => {
    if (pending) return
    if (draft.trim() === '') {
      setEmpty(true)
      return
    }
    setPending(true)
    setFailure(null)
    void startBranches({ kind: 'edit', sessionId, turn, text: draft }, { ownerSessionId: sessionId, openStarted: true }).then((outcome) => {
      setPending(false)
      if (outcome.ok) panel.close()
      else setFailure(outcome.failure)
    })
  }
  return (
    <>
      <span ref={panel.anchorRef} className={css.split}>
        <Tooltip label={t('edit.action')} side="bottom" disabled={!hover || panel.open}>
          <button
            type="button"
            className={classes(css.action, panel.open && css.open)}
            aria-label={t('edit.action')}
            aria-haspopup="dialog"
            aria-expanded={panel.open}
            data-loom-edit-branch=""
            onClick={() => {
              if (!panel.open) {
                setDraft(text)
                setFailure(null)
                setEmpty(false)
              }
              panel.setOpen(!panel.open)
            }}
          >
            <IconEditOutlineRegular />
          </button>
        </Tooltip>
      </span>
      <LoomPanel panel={panel} label={t('edit.title', { turn })}>
        <p className={panelCss.title}><IconEditOutlineRegular />{t('edit.title', { turn })}</p>
        <div className={panelCss.rule} aria-hidden="true" />
        <InlineEditor
          className={classes(panelCss.editor)}
          value={draft}
          label={t('edit.label')}
          onChange={(value) => {
            setDraft(value)
            setEmpty(false)
          }}
          onSave={submit}
          onCancel={panel.close}
        />
        {hasAttachments && <p className={panelCss.second}>{t('edit.attachments')}</p>}
        {empty && <p className={panelCss.error} role="alert">{t('edit.empty')}</p>}
        {failure !== null && <p className={panelCss.error} role="alert">{failureText(failure, t)}</p>}
        <div className={panelCss.footer}>
          <span className={panelCss.footerNote}>{t('edit.note')}</span>
          <Button variant="ghost" size="sm" onClick={panel.close}>{t('action.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={pending} onClick={submit}>{t('edit.submit')}</Button>
        </div>
      </LoomPanel>
    </>
  )
}
