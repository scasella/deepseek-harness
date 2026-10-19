/** List-price preview of the exact prose cursor request. */
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { LoomPrefixSpan } from '@deepseek-ai/dsh-experimental-loom/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CostRow } from './CostRow.tsx'
import type { LoomViewProps } from './LoomView.tsx'
import { loomEstimateKey } from './reads.ts'
import type { LoomTranslate } from './format.ts'

/**
 * Read the list-price estimate for prose without changing the Session's global route.
 * @param props - exact cursor, controls, optional local route, estimate hook, and localized copy.
 * @returns the normal Cost row, including token-only fallback for an unpriced model.
 */
export function WeaveCost({ sessionId, n, maxTokens, prefix, selection, useLoomEstimate, t }: {
  sessionId: SessionId
  n: number
  maxTokens: number
  prefix: readonly LoomPrefixSpan[]
  selection: ModelSelection | null
  useLoomEstimate: LoomViewProps['useLoomEstimate']
  t: LoomTranslate
}) {
  const state = useLoomEstimate(loomEstimateKey({ sessionId, kind: 'weave', count: n, maxTokens, prefix,
    ...selection === null ? {} : { selection } }))
  const history = state?.status === 'ready' ? state.value.historicalInput : undefined
  return <><CostRow state={state} count={n} t={t} />
    <dt>{t('weave.priceBasis')}</dt><dd>{history === undefined ? t('weave.noPriceBasis') : t('weave.priceHistory', {
      samples: history.samples, cap: maxTokens, match: t(history.prefixMatches ? 'weave.samePrefix' : 'weave.otherPrefix'),
    })}</dd>
  </>
}
