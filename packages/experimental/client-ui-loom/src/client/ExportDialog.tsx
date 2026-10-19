/** Read-only Loom path exports, including the persisted curation record. */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LoomExportRequest, LoomNodeId, LoomWeaveState } from '@deepseek-ai/dsh-experimental-loom/types'
import type { LoomTranslate } from './format.ts'
import { downloadLoom, type LoomProseCalls } from './prose.ts'
import { classes } from './classes.ts'
import css from './ExportDialog.module.css'

/**
 * Render a download dialog; an export is prepared only after Download is pressed.
 * @param props - current path, persisted curation values, Host exporter, visibility, and localized labels.
 * @returns the modal with scope, format, preview, and recoverable failure state.
 */
export function ExportDialog({ open, close, sessionId, nodeId, state, preview, exportLoom, t }: {
  open: boolean
  close: () => void
  sessionId: SessionId
  nodeId?: LoomNodeId
  state: LoomWeaveState
  preview: string
  exportLoom: LoomProseCalls['export']
  t: LoomTranslate
}) {
  const [mode, setMode] = useState<LoomExportRequest['mode']>('path')
  const [format, setFormat] = useState<'html' | 'text' | 'json'>('html')
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [saved, setSaved] = useState(false)
  const download = async (): Promise<void> => {
    setPending(true); setFailed(false); setSaved(false)
    try {
      const result = await exportLoom({ sessionId, mode, format, ...nodeId === undefined ? {} : { nodeId } })
      if (!result.ok) { setFailed(true); return }
      downloadLoom(result.value)
      setSaved(true)
    } catch (_error: unknown) {
      setFailed(true)
    } finally { setPending(false) }
  }
  return (
    <Modal open={open} onClose={close} title={t('export.title')} closeLabel={t('export.close')} className={classes(css.dialog)}
      footer={<><Button onClick={close}>{t('export.cancel')}</Button><Button variant="primary" disabled={pending}
        onClick={() => { void download() }}>{t(pending ? 'export.preparing' : 'export.download')}</Button></>}>
      <div className={css.columns}>
        <div>
          <fieldset className={css.options}><legend>{t('export.scope')}</legend>
            {(['path', 'siblings', 'kept'] as const).map(value => <label key={value}>
              <input type="radio" name="loom-export-scope" checked={mode === value} onChange={() => { setMode(value) }} />
              {t(`export.${value}`)}
            </label>)}
          </fieldset>
          <h3>{t('export.curation')}</h3>
          <p>{t('weave.meter', { choices: state.choices.length, bits: state.curationBits.toFixed(1), tokens: state.modelTokens,
            rate: state.modelTokens === 0 ? '0' : (state.curationBits / state.modelTokens).toFixed(3) })}</p>
          <p className={css.note}>{t('export.record')}</p>
          <label className={css.format}>{t('export.format')}<select value={format} onChange={(event) => { setFormat(event.target.value as typeof format) }}>
            <option value="html">{t('export.html')}</option><option value="text">{t('export.text')}</option><option value="json">{t('export.json')}</option>
          </select></label>
          {failed && <p role="alert">{t('export.failed')}</p>}
          {saved && <p role="status">{t('export.saved')}</p>}
        </div>
        <section className={css.preview} aria-label={t('export.preview')}><h3>{t('export.preview')}</h3><p>{preview || t('export.emptyPreview')}</p></section>
      </div>
    </Modal>
  )
}
