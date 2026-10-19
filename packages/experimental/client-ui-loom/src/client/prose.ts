/** Typed prose reads and exact cursor-prefix attribution, shared by Weave and token exploration. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {
  LoomChooseRequest, LoomCounterfactualRequest, LoomCounterfactualValue, LoomCurationValue,
  LoomExportRequest, LoomExportValue, LoomNodeId, LoomPrefixSpan, LoomProbeNode, LoomProbeRequest, LoomProbeValue,
  LoomWeaveNode, LoomWeaveRequest, LoomWeaveState, LoomWeaveValue,
} from '@deepseek-ai/dsh-experimental-loom/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createLoomReadSources, type LoomReadSources, type LoomReadState } from './read-sources.ts'

/** Host operations behind the prose view and counterfactual result editor. */
export interface LoomProseCalls {
  weave: (request: LoomWeaveRequest) => Promise<RemoteResult<LoomWeaveValue>>
  weaveState: (request: { sessionId: SessionId }) => Promise<RemoteResult<LoomWeaveState>>
  choose: (request: LoomChooseRequest) => Promise<RemoteResult<LoomCurationValue>>
  probe: (request: LoomProbeRequest) => Promise<RemoteResult<LoomProbeValue>>
  export: (request: LoomExportRequest) => Promise<RemoteResult<LoomExportValue>>
  counterfactual: (request: LoomCounterfactualRequest) => Promise<RemoteResult<LoomCounterfactualValue>>
}

/** Injected prose actions and persisted document source. */
export interface LoomProseInjected {
  keyedHooks: { loomWeave: (key: string) => ObservableSnapshot<LoomReadState<LoomWeaveState>> }
  weave: LoomProseCalls['weave']
  choose: LoomProseCalls['choose']
  probe: LoomProseCalls['probe']
  exportLoom: LoomProseCalls['export']
  refreshWeave: (sessionId: SessionId) => void
}

/**
 * Own persisted prose reads for one plugin lifetime.
 * @param calls - generated Host prose methods.
 * @returns keyed document reads, refreshed after successful writes by the owner.
 */
export function createLoomProseReads(calls: Pick<LoomProseCalls, 'weaveState'>): LoomReadSources<LoomWeaveState> {
  return createLoomReadSources(key => calls.weaveState({ sessionId: SessionId(key) }), 'loom-weave')
}

/**
 * Reconstruct the exact text at the end of one settled prose node.
 * @param node - persisted continuation with its exact request prefix.
 * @returns attributed spans, including the node's own model text.
 */
export function weaveDocument(node: LoomWeaveNode): readonly LoomPrefixSpan[] {
  return [...node.prefix, { text: node.text, author: 'model', node: node.id }]
}

/**
 * Preserve captured authorship for an unchanged cursor prefix; edited text is user-authored.
 * @param text - editor contents through the selected cursor.
 * @param recorded - exact attributed document before the edit.
 * @returns exact model/user spans for the auxiliary request.
 */
export function weavePrefix(text: string, recorded: readonly LoomPrefixSpan[]): readonly LoomPrefixSpan[] {
  const full = recorded.map(span => span.text).join('')
  let common = 0
  while (common < text.length && common < full.length && text[common] === full[common]) common += 1
  let remaining = common
  const spans: LoomPrefixSpan[] = []
  for (const span of recorded) {
    if (remaining === 0) break
    const take = Math.min(remaining, span.text.length)
    if (take > 0) spans.push(span.author === 'alternative' && take < span.text.length
      ? { text: span.text.slice(0, take), author: 'user' }
      : { ...span, text: span.text.slice(0, take) })
    remaining -= take
  }
  if (common < text.length) spans.push({ text: text.slice(common), author: 'user' })
  return spans
}

/**
 * Find the last model node named by a cursor prefix.
 * @param spans - attributed prefix at the cursor.
 * @returns its immediate prose parent, or null for a user-only opening.
 */
export function weaveParent(spans: readonly LoomPrefixSpan[]): LoomNodeId | null {
  return spans.findLast(span => span.node !== undefined)?.node ?? null
}

/**
 * Reconstruct one explored path using each recorded provider alternative.
 * @param value - settled exploration.
 * @param id - last token of the selected path.
 * @param prefix - exact cursor prefix used by the exploration.
 * @returns that prefix followed by attributed alternative tokens in path order.
 */
export function probePrefix(value: LoomProbeValue, id: LoomProbeNode['id'], prefix: readonly LoomPrefixSpan[]): readonly LoomPrefixSpan[] {
  const path: LoomPrefixSpan[] = []
  let node = value.nodes.find(candidate => candidate.id === id)
  while (node !== undefined) {
    path.unshift({ text: node.token, author: 'alternative', node: node.sourceNodeId, tokenIndex: node.tokenIndex })
    node = node.parent === null ? undefined : value.nodes.find(candidate => candidate.id === node?.parent)
  }
  return [...prefix, ...path]
}

/**
 * Hand a Host export route to the browser's authenticated same-origin download manager.
 * @param value - Host-authorized filename and route.
 */
export function downloadLoom(value: LoomExportValue): void {
  const link = document.createElement('a')
  link.href = value.url
  link.download = value.filename
  link.click()
}
