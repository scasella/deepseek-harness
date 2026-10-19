/** Captured token paths with probability-sized blocks, written values, and selected-path magnification. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LoomPrefixSpan, LoomProbeNode, LoomProbeValue } from '@deepseek-ai/dsh-experimental-loom/types'
import type { LoomTranslate } from './format.ts'
import { probePrefix } from './prose.ts'
import { probeAncestors, probeGeometry } from './probe-layout.ts'
import css from './ProbePanel.module.css'

/** A settled exploration and the exact prefix on which its requests ran. */
export interface ProbePanelProps {
  value: LoomProbeValue
  prefix: readonly LoomPrefixSpan[]
  disabled: boolean
  t: LoomTranslate
  branch: (prefix: readonly LoomPrefixSpan[]) => void
}

/**
 * Select a recorded token path with accessible controls beside proportional probability blocks.
 * @param props - captured paths, original cursor prefix, and continuation action.
 * @returns the full distribution, selected subtree, written probabilities, and explicit continuation action.
 */
export function ProbePanel({ value, prefix, disabled, t, branch }: ProbePanelProps) {
  const [selected, setSelected] = useState(value.nodes.at(-1)?.id)
  const selectedNode = value.nodes.find(node => node.id === selected) ?? value.nodes.at(-1)
  const path = selectedNode === undefined ? [] : probePrefix(value, selectedNode.id, prefix)
  return <div>
    <p>{t('probe.requests', { count: value.requests })}</p>
    <p className={css.legend}>{t('probe.legend')}</p>
    <ProbabilityDiagram value={value} selected={selectedNode} t={t} />
    {value.nodes.length > 0 && <label className={css.selector}>{t('probe.selectPath')}<select value={(selectedNode as LoomProbeNode).id}
      onChange={(event) => { setSelected(event.target.value as LoomProbeNode['id']) }}>
      {value.nodes.map(node => <option key={node.id} value={node.id}>{t('probe.option', {
        text: probeAncestors(value, node).map(part => part.token).join(''), probability: (node.probability * 100).toFixed(1),
        cumulative: (node.cumulativeProbability * 100).toFixed(1),
      })}</option>)}
    </select></label>}
    {selectedNode !== undefined && <section className={css.zoom} aria-label={t('probe.zoom')}>
      <p className={css.path}>{t('probe.selected', { text: path.slice(prefix.length).map(span => span.text).join('') })}</p>
      <div className={css.zoomContent}>
        <ProbabilityDiagram value={value} root={selectedNode} selected={selectedNode} t={t} />
        <dl className={css.metrics}>
          <dt>{t('probe.pathProbability')}</dt><dd>{t('probe.product', {
            probability: (selectedNode.cumulativeProbability * 100).toFixed(1),
            factors: probeAncestors(value, selectedNode).map(node => `${(node.probability * 100).toFixed(1)}%`).join(' × '),
          })}</dd>
          <dt>{t('probe.magnification')}</dt><dd>{t('probe.times', { value: (1 / selectedNode.cumulativeProbability).toFixed(1) })}</dd>
          <dt>{t('probe.information')}</dt><dd>{t('probe.bits', { value: (-Math.log2(selectedNode.cumulativeProbability)).toFixed(1) })}</dd>
        </dl>
      </div>
      <Button disabled={disabled} onClick={() => { branch(path) }}>{t('probe.branch')}</Button>
    </section>}
    {value.truncated && <p>{t('probe.truncated')}</p>}
  </div>
}

/** Visual rectangles are accompanied by the full written path selector; small probabilities need no small touch target. */
function ProbabilityDiagram({ value, root, selected, t }: {
  value: LoomProbeValue
  root?: LoomProbeNode
  selected: LoomProbeNode | undefined
  t: LoomTranslate
}) {
  const layout = probeGeometry(value, root)
  return <div className={css.scroll} role="img"
    aria-label={t(root === undefined ? 'probe.paths' : 'probe.zoomDiagram')}>
    <div className={css.diagram} aria-hidden="true"
      style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(112px, 1fr))` }}>
      {Array.from({ length: layout.columns }, (_, depth) => <div key={depth} className={css.column}>
        <div className={css.track}>{layout.rectangles.filter(rectangle => rectangle.depth === depth).map((rectangle, index) => <div
          key={index}
          className={rectangle.node === undefined ? css.unshown : css.block} data-selected={rectangle.node?.id === selected?.id}
          style={{ top: `${rectangle.top / layout.scale * 100}%`, height: `${rectangle.mass / layout.scale * 100}%` }}>
          <span>{rectangle.node === undefined ? t('probe.unshown', { probability: (rectangle.mass / layout.scale * 100).toFixed(1) })
            : t('probe.block', { token: rectangle.node.token, probability: (rectangle.node.probability * 100).toFixed(1) })}</span>
        </div>)}</div>
        <span className={css.columnLabel}>{t('probe.column', { depth: (root?.depth ?? 1) + depth })}</span>
      </div>)}
    </div>
  </div>
}
