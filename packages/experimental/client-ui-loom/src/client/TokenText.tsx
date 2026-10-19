/** Captured token probabilities with an equivalent written explanation and optional prose branching. */
import { useState } from 'react'
import type { BlockTokenLogprobs, TokenAlternative } from '@deepseek-ai/dsh-llm/types'
import type { LoomTranslate } from './format.ts'
import { classes } from './classes.ts'
import { LoomPanel, useAnchoredPanel } from './panel.tsx'
import css from './TokenText.module.css'

/** Probability display and optional alternative selection of one captured text block. */
export interface TokenTextProps {
  text: string
  logprobs?: BlockTokenLogprobs
  t: LoomTranslate
  /** Forking is offered only when the owner supports tool-free prose continuation. */
  onAlternative?: (index: number, alternative: TokenAlternative) => void
}

/**
 * Format a captured log probability as a percentage.
 * @param logprob - provider log probability.
 * @returns a decimal percentage without its localized percent sign.
 */
export function probabilityPercent(logprob: number): string {
  const percent = Math.exp(logprob) * 100
  return percent < 1 ? percent.toFixed(1) : percent.toFixed(0)
}

/**
 * Render probabilities only where captured tokens reproduce the exact text.
 * @param props - recorded text, optional captured values, localized copy, and optional alternative action.
 * @returns text plus a keyboard-accessible probability inspector; uncaptured text stays plain.
 */
export function TokenText({ text, logprobs, t, onAlternative }: TokenTextProps) {
  const panel = useAnchoredPanel('bottom')
  const [selected, setSelected] = useState(0)
  if (logprobs === undefined || logprobs.tokens.join('') !== text) return <span className={css.text}>{text}</span>
  const percent = (value: number) => t('token.percent', { value: probabilityPercent(value) })
  const selectedLogprob = logprobs.logprobs[selected]
  return (
    <span className={css.text}>
      {logprobs.tokens.map((token, index) => {
        const logprob = logprobs.logprobs[index]
        if (logprob === null || logprob === undefined) return <span key={index}>{token}</span>
        const probability = Math.exp(logprob)
        return <span key={index}><button type="button"
          className={classes(css.token, probability < 0.3 && css.unlikely, probability < 0.05 && css.rare)}
          aria-haspopup="dialog" aria-label={t('token.details', { token, probability: percent(logprob) })}
          onClick={(event) => {
            panel.anchorRef.current = event.currentTarget.parentElement
            setSelected(index)
            panel.setOpen(true)
          }}>{token}</button></span>
      })}
      <LoomPanel panel={panel} label={t('token.inspector')}>
        <p className={css.heading}>{t('token.details', { token: logprobs.tokens[selected] ?? '',
          probability: selectedLogprob === null || selectedLogprob === undefined ? t('token.uncaptured') : percent(selectedLogprob) })}</p>
        <p className={css.note}>{t('token.legend')}</p>
        <ul className={css.alternatives}>{(logprobs.top[selected] ?? []).map((alternative, index) => (
          <li key={index}>{onAlternative === undefined
            ? <span>{t('token.alternative', { token: alternative.token, probability: percent(alternative.logprob) })}</span>
            : <button type="button" onClick={() => { onAlternative(selected, alternative); panel.close() }}>
              {t('token.alternative', { token: alternative.token, probability: percent(alternative.logprob) })}
            </button>}</li>
        ))}</ul>
        <button type="button" className={css.close} onClick={panel.close}>{t('token.close')}</button>
      </LoomPanel>
    </span>
  )
}
