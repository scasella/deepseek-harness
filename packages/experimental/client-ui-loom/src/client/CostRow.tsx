/**
 * The Cost row of the Regenerate panel and the Branch ×N form: what the
 * branches would cost at the route's list price, or in own tokens when the
 * route has no configured price, and the share of input the family's cache
 * is expected to serve. An estimate that fails shows no row.
 */
import { costReading } from './cost.ts'
import type { LoomTranslate } from './format.ts'
import type { LoomReadState } from './read-sources.ts'
import type { LoomEstimateValue } from '@deepseek-ai/dsh-experimental-loom/types'
import panelCss from './panel.module.css'

/** Props of the Cost row. */
export interface CostRowProps {
  /** The estimate's read state; undefined reads as loading. */
  readonly state: LoomReadState<LoomEstimateValue> | undefined
  /** Children the request would create. */
  readonly count: number
  readonly t: LoomTranslate
}

/**
 * Render the Cost term and its description in a details grid.
 * @param props - the selected route's estimate, the child count, and copy.
 * @returns the `dt`/`dd` pair, or null for a failed read.
 */
export function CostRow({ state, count, t }: CostRowProps) {
  if (state?.status === 'failed') return null
  const reading = state?.status === 'ready' ? costReading(state.value, count, t) : undefined
  return (
    <>
      <dt>{t('cost.title')}</dt>
      <dd>
        {state?.status !== 'ready'
          ? <span role="status">{t('cost.loading')}</span>
          : reading === undefined
            ? t('cost.none')
            : (
              <>
                {reading.first}
                {reading.second !== undefined && <span className={panelCss.second}>{reading.second}</span>}
              </>
            )}
      </dd>
    </>
  )
}
