/** Content-only tool-result editor that starts an attributed continuation in a new fork. */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { LoomProseCalls } from './prose.ts'
import type { NS } from './locales.ts'
import { classes } from './classes.ts'
import css from './CounterfactualAction.module.css'

/** Host branch operation and post-commit navigation. */
export interface CounterfactualInjected {
  counterfactual: LoomProseCalls['counterfactual']
  openSession: (sessionId: SessionId) => void
}

/** Result action with the tool owner's stage guard. */
export type CounterfactualActionProps = PropsRuntime<'tool.call.actions'> & InjectFace<CounterfactualInjected> & PropsLocale<typeof NS>

/**
 * Render the editor action only for a settled tool result.
 * @param props - complete tool result, Session, branch operation, navigation, and copy.
 * @returns the action and modal, or null before settlement.
 */
export function CounterfactualAction(props: CounterfactualActionProps) {
  if (props.phase !== 'result' || props.block.parentCallId !== undefined || !Number.isSafeInteger(props.block.seq)) return null
  return <CounterfactualResult {...props} />
}

function CounterfactualResult({ sessionId, block, counterfactual, openSession, t }: CounterfactualActionProps & { phase: 'result' }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [incomplete, setIncomplete] = useState<SessionId | null>(null)
  const start = async (): Promise<void> => {
    setPending(true); setFailed(false)
    try {
      const result = await counterfactual({ sessionId, resultSeq: SessionSeq(block.seq), content: [{ type: 'text', text: draft }] })
      if (!result.ok) {
        const details: unknown = result.error.details
        if (result.error.code === 'loom/counterfactual-incomplete' && details !== null && typeof details === 'object'
          && 'childSessionId' in details && typeof details.childSessionId === 'string') setIncomplete(SessionId(details.childSessionId))
        else setFailed(true)
        return
      }
      openSession(result.value.sessionId)
      setOpen(false)
    } catch (_error: unknown) { setFailed(true) } finally { setPending(false) }
  }
  return <>
    <button type="button" className={css.action} onClick={() => {
      setDraft(block.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'))
      setFailed(false); setIncomplete(null); setOpen(true)
    }}>{t('counterfactual.action')}</button>
    <Modal open={open} onClose={() => { if (!pending) setOpen(false) }} title={t('counterfactual.title')}
      closeLabel={t('counterfactual.close')} className={classes(css.dialog)}
      footer={<><Button disabled={pending} onClick={() => { setOpen(false) }}>{t('export.cancel')}</Button>
        <Button variant="primary" disabled={pending || incomplete !== null} onClick={() => { void start() }}>{t(pending ? 'counterfactual.starting' : 'counterfactual.start')}</Button></>}>
      <p className={css.note}>{t('counterfactual.note')}</p>
      <label className={css.field}>{t('counterfactual.content')}<textarea rows={10} value={draft} disabled={pending}
        onChange={(event) => { setDraft(event.target.value) }} /></label>
      {failed && <p role="alert">{t('counterfactual.failed')}</p>}
      {incomplete !== null && <p role="alert">{t('counterfactual.incomplete')} <Button onClick={() => { openSession(incomplete) }}>{t('counterfactual.open')}</Button></p>}
    </Modal>
  </>
}
