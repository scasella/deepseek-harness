/** Prose at an exact cursor: retain every sibling, preview it, and choose a continuation. */
import { useState } from 'react'
import { Button, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { LoomNodeId, LoomPrefixSpan, LoomProbeValue, LoomWeaveNode } from '@deepseek-ai/dsh-experimental-loom/types'
import type { BlockTokenLogprobs, TokenAlternative } from '@deepseek-ai/dsh-llm/types'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { ExportDialog } from './ExportDialog.tsx'
import { TokenText } from './TokenText.tsx'
import { capturedPrefix } from './captured-prefix.ts'
import { proseFailureKey, type ProseFailureKey } from './prose-failure.ts'
import { ProbePanel } from './ProbePanel.tsx'
import { weaveDocument, weaveParent, weavePrefix, type LoomProseInjected } from './prose.ts'
import type { LoomViewProps } from './LoomView.tsx'
import type { createLoomViewStore } from './view-store.ts'
import { RouteRow } from './RouteRow.tsx'
import { WeaveCost } from './WeaveCost.tsx'
import { weaveSets, type WeaveSet } from './weave-sets.ts'
import type { NS } from './locales.ts'
import css from './WeaveView.module.css'

/** Conversation runtime with persisted prose and mutation operations. */
export type WeaveViewProps = PropsRuntime<'conversation.view'> & InjectFace<LoomProseInjected> & PropsLocale<typeof NS>
  & PropsStore<ReturnType<typeof createLoomViewStore>> & Pick<LoomViewProps, 'useLoomRoutes' | 'loadRoutes' | 'useLoomEstimate'>

/**
 * Render the prose document, cursor editor, probability probe, and retained continuations.
 * @param props - Session identity, persisted source, Host operations, and localized copy.
 * @returns the Weave view; failures retain the document and offer another attempt.
 */
export function WeaveView({
  sessionId, useLoomWeave, weave, choose, probe, exportLoom, refreshWeave, useStore, actions, useProjection,
  useLoomRoutes, loadRoutes, useLoomEstimate, t,
}: WeaveViewProps) {
  const read = useLoomWeave(sessionId)
  const [selected, setSelected] = useState<LoomNodeId | null>(null)
  const draft = useStore(state => state.prose)
  const { text: edited, basis: editorBasis, cursor, n, maxTokens, temperature, selection, requestSeq: candidateRequest } = draft
  const setEdited = (text: string | null): void => { actions.prose({ text }) }
  const setEditorBasis = (basis: readonly LoomPrefixSpan[] | null): void => { actions.prose({ basis }) }
  const setCursor = (cursor: number | null): void => { actions.prose({ cursor }) }
  const setCandidateRequest = (requestSeq: SessionSeq | null): void => { actions.prose({ requestSeq }) }
  const inherited = useProjection('modelSelection', value => value?.next ?? undefined)
  const route = inherited === undefined ? undefined : { provider: inherited.provider, model: inherited.model }
  const routes = useLoomRoutes(value => value)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<ProseFailureKey | null>(null)
  const [preview, setPreview] = useState<LoomNodeId | null>(null)
  const [exploration, setExploration] = useState<{ value: LoomProbeValue; prefix: readonly LoomPrefixSpan[] } | null>(null)
  const [depth, setDepth] = useState(2)
  const [cutoff, setCutoff] = useState(0.02)
  const [exportOpen, setExportOpen] = useState(false)
  if (read === undefined || read.status === 'loading') return <div className={css.loading} role="status" aria-label={t('weave.loading')}><IconLoadingOutlineRegular size={24} /></div>
  if (read.status === 'failed') return <div className={css.loading}><p role="alert">{t('weave.readFailed')}</p><Button onClick={() => { refreshWeave(sessionId) }}>{t('multiverse.retry')}</Button></div>
  const state = read.value
  const nodes = state.nodes.filter(node => node.kind === 'weave')
  const sets = weaveSets(state.nodes)
  const chosen = nodes.find(node => node.id === (selected ?? state.choices.at(-1)?.nodeId))
  const recorded = chosen === undefined ? nodes.at(-1)?.prefix ?? [] : weaveDocument(chosen)
  const documentText = recorded.map(span => span.text).join('')
  const text = edited ?? documentText
  const prefix = weavePrefix(text.slice(0, cursor ?? text.length), editorBasis ?? recorded)
  const parent = weaveParent(prefix)
  const siblings = nodes.filter(node => node.parent === parent)
  const latestRequest = candidateRequest ?? siblings.at(-1)?.requestSeq
  const candidates = nodes.filter(node => node.requestSeq === latestRequest)
  const previewNode = candidates.find(node => node.id === preview)
  const busy = pending || read.refreshing
  const openSet = (set: Pick<WeaveSet, 'requestSeq' | 'prefix'>): void => {
    setCandidateRequest(set.requestSeq); setPreview(null)
    setEditorBasis(set.prefix); setEdited(set.prefix.map(span => span.text).join('')); setCursor(null)
    setExploration(null)
  }
  const generate = async (override?: readonly LoomPrefixSpan[]): Promise<void> => {
    if (busy) return
    setPending(true); setFailed(null)
    const spans = override ?? prefix
    try {
      const result = await weave({ sessionId, parent: weaveParent(spans), prefix: spans, n,
        controls: { maxTokens, ...temperature === null ? {} : { temperature } },
        ...selection === null ? {} : { route: selection } })
      if (!result.ok) { setFailed(proseFailureKey(result.error)); return }
      setCandidateRequest(result.value.requestSeq)
      setPreview(null)
      refreshWeave(sessionId)
    } catch (_error: unknown) { setFailed(proseFailureKey()) } finally { setPending(false) }
  }
  const select = async (node: LoomWeaveNode): Promise<void> => {
    if (busy) return
    setPending(true); setFailed(null)
    try {
      const result = await choose({ sessionId, nodeId: node.id })
      if (!result.ok) { setFailed(proseFailureKey(result.error)); return }
      setSelected(node.id); setEdited(null); setEditorBasis(null); setCursor(null); setPreview(null); setExploration(null)
      setCandidateRequest(node.requestSeq)
      refreshWeave(sessionId)
    } catch (_error: unknown) { setFailed(proseFailureKey()) } finally { setPending(false) }
  }
  const alternative = (node: LoomWeaveNode, index: number, option: TokenAlternative, captured: BlockTokenLogprobs): void => {
    if (busy) return
    const before = captured.tokens.slice(0, index).join('')
    const spans: LoomPrefixSpan[] = [...node.prefix,
      ...before === '' ? [] : [{ text: before, author: 'model' as const, node: node.id }],
      { text: option.token, author: 'alternative', node: node.id, tokenIndex: index }]
    setEdited(spans.map(span => span.text).join('')); setEditorBasis(spans); setCursor(null)
    void generate(spans)
  }
  const explore = async (): Promise<void> => {
    setPending(true); setFailed(null)
    try {
      const result = await probe({ sessionId, parent, prefix, depth, cutoff, ...selection === null ? {} : { route: selection } })
      if (!result.ok) { setFailed(proseFailureKey(result.error)); return }
      setExploration({ value: result.value, prefix })
    } catch (_error: unknown) { setFailed(proseFailureKey()) } finally { setPending(false) }
  }
  return (
    <section className={css.root} aria-label={t('weave.title')} tabIndex={0} aria-keyshortcuts="ArrowDown ArrowUp 1 2 3 4 5 6 7 8 9 g" onKeyDown={(event) => {
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, button, select, [contenteditable="true"]') !== null) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const index = candidates.findIndex(node => node.id === preview)
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const next = candidates[(index + (event.key === 'ArrowDown' ? 1 : candidates.length - 1) + candidates.length) % candidates.length]
        if (next !== undefined) setPreview(next.id)
      } else if (/^[1-9]$/.test(event.key)) {
        const node = candidates[Number(event.key) - 1]
        if (node !== undefined && node.status === 'completed') { event.preventDefault(); void select(node) }
      } else if (event.key === 'g') { event.preventDefault(); void generate() }
    }}>
      <div className={css.header}><h2>{t('weave.title')}</h2><Button onClick={() => { setExportOpen(true) }}>{t('export.title')}</Button></div>
      <p className={css.legend}>{t('token.legend')}</p>
      <div className={css.document}>
        {recorded.map((span, index) => {
          const node = nodes.find(candidate => candidate.id === span.node)
          const captured = span.author !== 'model' || node?.logprobs === undefined ? undefined : capturedPrefix(span.text, node.logprobs)
          return <section key={index} className={css.block}>
            <div className={css.attribution}>{t(span.author === 'model' ? 'weave.model' : span.author === 'alternative' ? 'weave.alternative' : 'weave.user')}
              {span.author === 'model' && node !== undefined && <button type="button" className={css.alternatives} onClick={() => {
                openSet(node); setPreview(node.id)
              }}>{t('weave.showAlternatives')}</button>}
            </div>
            <div><TokenText text={span.text} {...captured === undefined ? {} : { logprobs: captured }}
              {...node === undefined || captured === undefined ? {} : {
                onAlternative: (at: number, option: TokenAlternative) => { alternative(node, at, option, captured) },
              }} t={t} /></div>
          </section>
        })}
      </div>
      <label className={css.editor}>{t('weave.cursor')}<textarea value={text} rows={5} spellCheck={false}
        onChange={(event) => { setEdited(event.target.value); setCursor(event.target.selectionStart) }}
        onSelect={(event) => { setCursor(event.currentTarget.selectionStart) }} /></label>
      <div className={css.controls}>
        <label>{t('weave.count')}<input type="number" min={1} value={n} onChange={(event) => { actions.prose({ n: Number(event.target.value) }) }} /></label>
        <label>{t('weave.tokens')}<input type="number" min={1} value={maxTokens} onChange={(event) => { actions.prose({ maxTokens: Number(event.target.value) }) }} /></label>
        <label>{t('weave.temperature')}<input type="number" min={0} max={2} step={0.1} value={temperature ?? ''}
          placeholder={t('weave.configured')} onChange={(event) => { actions.prose({ temperature: event.target.value === '' ? null : Number(event.target.value) }) }} /></label>
        <Button variant="primary" disabled={busy || !Number.isInteger(n) || n < 1 || !Number.isInteger(maxTokens) || maxTokens < 1}
          onClick={() => { void generate() }}>{t(pending ? 'weave.generating' : 'weave.generate')}</Button>
      </div>
      <dl className={css.route}>
        <RouteRow route={route} selection={selection} routes={routes} loadRoutes={loadRoutes} sameLabel={t('route.sameBranch')}
          onSelect={(selection) => { actions.prose({ selection }) }} t={t} />
        <dt>{t('weave.thinking')}</dt><dd>{t('weave.thinkingOff')}</dd>
        <WeaveCost sessionId={sessionId} n={n} maxTokens={maxTokens} prefix={prefix} selection={selection ?? route ?? null}
          useLoomEstimate={useLoomEstimate} t={t} />
      </dl>
      {failed !== null && <p role="alert">{t(failed)}</p>}
      {sets.length > 0 && <label className={css.history}>{t('weave.history')}<select value={latestRequest ?? ''} onChange={(event) => {
        const set = sets.find(candidate => candidate.requestSeq === Number(event.target.value))
        if (set !== undefined) openSet(set)
      }}>
        <option value="" disabled>{t('weave.currentCursor')}</option>
        {sets.map((set, index) => <option key={set.requestSeq} value={set.requestSeq}>{t('weave.set', {
          index: index + 1, count: set.nodes.length, prefix: set.prefix.map(span => span.text).join('').slice(-60),
        })}</option>)}
      </select></label>}
      {previewNode !== undefined && <div className={css.preview}><p className={css.legend}>{t('weave.preview')}</p>
        <TokenText text={previewNode.text} {...previewNode.logprobs === undefined ? {} : { logprobs: previewNode.logprobs }} t={t} /></div>}
      <div className={css.candidates} aria-label={t('weave.candidates')}>
        {candidates.map((node, index) => <section key={node.id} className={css.candidate}>
          <button type="button" className={css.previewButton} aria-pressed={preview === node.id} onClick={() => { setPreview(node.id) }}>
            <span>{t('weave.variant', { index: index + 1, count: candidates.length })}</span><p>{node.text || t(node.status === 'failed' ? 'weave.statusFailed' : `weave.${node.status}`)}</p>
          </button>
          {node.status !== 'completed' && <div>
            <p role="status">{t(node.status === 'failed' ? 'weave.candidateFailed' : 'prose.cancelled')}</p>
            {(node.error !== undefined || node.failureCode !== undefined) && <details>
              <summary>{t('weave.diagnostics')}</summary><pre>{node.error ?? node.failureCode}</pre>
            </details>}
          </div>}
          <Button disabled={busy || node.status !== 'completed'} onClick={() => { void select(node) }}>{t('weave.choose')}</Button>
        </section>)}
      </div>
      <details className={css.probe}><summary>{t('probe.title')}</summary>
        <div className={css.controls}><label>{t('probe.depth')}<input type="number" min={1} value={depth} onChange={(event) => { setDepth(Number(event.target.value)) }} /></label>
          <label>{t('probe.cutoff')}<input type="number" min={0.001} max={1} step={0.01} value={cutoff} onChange={(event) => { setCutoff(Number(event.target.value)) }} /></label>
          <Button disabled={busy} onClick={() => { void explore() }}>{t('probe.run')}</Button></div>
        {exploration !== null && <ProbePanel {...exploration} disabled={busy} t={t} branch={(spans) => {
          setEdited(spans.map(span => span.text).join('')); setEditorBasis(spans); setCursor(null); void generate(spans)
        }} />}
      </details>
      <p className={css.legend}>{t('weave.keys')}</p>
      <p className={css.meter}>{t('weave.meter', { choices: state.choices.length, bits: state.curationBits.toFixed(1), tokens: state.modelTokens,
        rate: state.modelTokens === 0 ? '0' : (state.curationBits / state.modelTokens).toFixed(3) })}</p>
      <ExportDialog open={exportOpen} close={() => { setExportOpen(false) }} sessionId={sessionId}
        {...chosen === undefined ? {} : { nodeId: chosen.id }} state={state} preview={documentText} exportLoom={exportLoom} t={t} />
    </section>
  )
}
