/**
 * Prompt-variant tallies in the Loom tab's tree pane: for each branch point
 * with a `variants` set, each prompt line with its samples and how many of
 * them are kept or set aside.
 */
import { useMemo } from 'react'
import type { LoomFamily } from '@deepseek-ai/dsh-experimental-loom/types'
import { cutReading, plainPreview, plural, type LoomTranslate } from './format.ts'
import type { LoomViewProps } from './LoomView.tsx'
import { variantTallies } from './tallies.ts'
import css from './LoomTree.module.css'

/** Props the view hands the tallies. */
export interface VariantTalliesProps extends Pick<LoomViewProps, 'useSessions' | 'useLoomBranching'> {
  readonly family: LoomFamily
  readonly t: LoomTranslate
}

/**
 * Render the tallies of every variant set in the family.
 * @param props - family, Session list, marks being saved, and copy.
 * @returns the tallies, or null for a family without variant sets.
 */
export function VariantTallies({ family, useSessions, useLoomBranching, t }: VariantTalliesProps) {
  const list = useSessions(state => state)
  const marks = useLoomBranching(state => state.marks)
  const points = useMemo(() => variantTallies(family, list, marks), [family, list, marks])
  if (points.length === 0) return null
  return (
    <section className={css.tallies} aria-label={t('tally.aria')}>
      {points.map(point => (
        <div key={point.pointId} className={css.tallyPoint}>
          <p className={css.tallyHeading}>{t('tally.heading', { cut: cutReading(point.cutTurn, point.openedTurn, t) })}</p>
          {point.sets.map(set => (
            <ol key={set.setId} className={css.tallyLines}>
              {set.lines.map(line => (
                <li key={line.variantKey} className={css.tallyLine}>
                  <span className={css.tallyPosition}>{line.position}</span>
                  <span className={css.tallyPrompt}>{line.prompt === '' ? t('tally.unknownLine') : plainPreview(line.prompt)}</span>
                  <span className={css.tallyCounts}>
                    {[
                      t(`tally.samples.${plural(line.samples)}`, { count: line.samples }),
                      t('tally.kept', { count: line.kept }),
                      t('tally.setAside', { count: line.setAside }),
                    ].join(t('sep'))}
                  </span>
                </li>
              ))}
            </ol>
          ))}
        </div>
      ))}
    </section>
  )
}
