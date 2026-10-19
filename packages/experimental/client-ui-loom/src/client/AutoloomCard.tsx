/** Compact autoloom tool cards projected only from recorded call/result content. */
import { useMemo } from 'react'
import { DisclosureRow, IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LoomLinkInjected } from './links.ts'
import type { NS } from './locales.ts'
import css from './AutoloomCard.module.css'

type AutoloomState = 'started' | 'queued' | 'running' | 'idle' | 'failed' | 'cancelled'
interface Child { index: number; state: AutoloomState; sessionId?: string; ownTokens?: number; stoppedByBudget: boolean; error?: string }

/** Detached presentation facts decoded from the tool's raw JSON text. */
export interface AutoloomCardValue {
  children: readonly Child[]
  sessionId?: string
  output?: string
  ownTokens?: number
  timedOut: boolean
  stoppedByBudget: boolean
  archived: boolean
  kept: boolean
  budget?: { branchesLeft: number; ownTokensLeft: number; maxDepth: number; usdLeft?: number }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Decode presentation facts from the recorded tool-result JSON, never tool meta.
 * @param text - raw first-party result content.
 * @returns detached card facts, or undefined when the content must be shown as plain text.
 */
export function autoloomCardValue(text: string): AutoloomCardValue | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch (_error: unknown) { return undefined }
  const data = record(value)
  if (data === undefined || !['children', 'sessionId', 'output', 'ownTokens', 'timedOut', 'stoppedByBudget', 'archived', 'mark', 'budget'].some(key => key in data)) return undefined
  if (data.children !== undefined && !Array.isArray(data.children)) return undefined
  const children: Child[] = []
  if (Array.isArray(data.children)) for (const candidate of data.children) {
    const child = record(candidate)
    if (child === undefined || typeof child.index !== 'number'
      || !['started', 'queued', 'running', 'idle', 'failed', 'cancelled'].includes(String(child.state))) return undefined
    children.push({ index: child.index, state: child.state as AutoloomState,
      ...typeof child.sessionId !== 'string' ? {} : { sessionId: child.sessionId },
      ...typeof child.ownTokens !== 'number' ? {} : { ownTokens: child.ownTokens },
      ...typeof child.error !== 'string' ? {} : { error: child.error }, stoppedByBudget: child.stoppedByBudget === true })
  }
  const budget = record(data.budget)
  return {
    children,
    ...typeof data.sessionId !== 'string' ? {} : { sessionId: data.sessionId },
    ...typeof data.output !== 'string' ? {} : { output: data.output },
    ...typeof data.ownTokens !== 'number' ? {} : { ownTokens: data.ownTokens },
    timedOut: data.timedOut === true, stoppedByBudget: data.stoppedByBudget === true,
    archived: data.archived === true, kept: data.mark === 'keep',
    ...budget === undefined || typeof budget.branchesLeft !== 'number' || typeof budget.ownTokensLeft !== 'number'
      || typeof budget.maxDepth !== 'number' ? {} : { budget: {
        branchesLeft: budget.branchesLeft, ownTokensLeft: budget.ownTokensLeft, maxDepth: budget.maxDepth,
        ...typeof budget.usdLeft !== 'number' ? {} : { usdLeft: budget.usdLeft },
      } },
  }
}

/** Autoloom keyed view with the standard tool disclosure context and Session navigation. */
export type AutoloomCardProps = PropsRuntime<'tool.call.toolview'> & InjectFace<Pick<LoomLinkInjected, 'openSession'>> & PropsLocale<typeof NS>

/**
 * Render branch status, remaining budgets, and durable child links.
 * @param props - raw Tool call/result, enclosing-turn disclosure, navigation, and localized labels.
 * @returns the compact card, retaining raw failure or unrecognized result text.
 */
export function AutoloomCard({ toolName, phase, block, useDisclosure, openSession, t }: AutoloomCardProps) {
  const { expanded, toggle } = useDisclosure()
  const raw = phase === 'result' ? block.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') : ''
  const value = useMemo(() => phase === 'result' && !block.isError ? autoloomCardValue(raw) : undefined, [phase, block, raw])
  const sessionId = value?.sessionId
  const kind = ['loom_expand', 'loom_wait', 'loom_read', 'loom_cull', 'loom_keep'].includes(toolName) ? toolName as 'loom_expand' | 'loom_wait' | 'loom_read' | 'loom_cull' | 'loom_keep' : 'loom_read'
  return <DisclosureRow icon={<IconBranchOutlineRegular size={16} />} title={t(`autoloom.${kind}`)}
    open={expanded} onToggle={toggle} expandable expandOnRowClick
    collapsedContent={<span className={css.summary}>{t(phase === 'result' ? block.isError ? 'autoloom.failed' : 'autoloom.finished' : 'autoloom.running')}</span>}>
    {expanded && <div className={css.body}>
      {value === undefined ? <pre className={css.output}>{raw || t('autoloom.pending')}</pre> : <>
        {value.children.length > 0 && <ol className={css.children}>{value.children.map((child) => {
          const childSessionId = child.sessionId
          return <li key={child.index}>
            {childSessionId === undefined ? <span>{t('autoloom.branch', { index: child.index + 1 })}</span>
              : <button type="button" onClick={() => { openSession(SessionId(childSessionId)) }}>{t('autoloom.branch', { index: child.index + 1 })}</button>}
            <span>{t(`autoloom.state.${child.state}`)}</span>
            {child.ownTokens !== undefined && <span>{t('autoloom.tokens', { count: child.ownTokens })}</span>}
            {child.stoppedByBudget && <span>{t('autoloom.budgetStopped')}</span>}
            {child.error !== undefined && <pre className={css.output}>{child.error}</pre>}
          </li>
        })}</ol>}
        {sessionId !== undefined && <button type="button" className={css.link} onClick={() => { openSession(SessionId(sessionId)) }}>{t('autoloom.open')}</button>}
        {value.budget !== undefined && <p>{t('autoloom.budget', { branches: value.budget.branchesLeft, tokens: value.budget.ownTokensLeft, depth: value.budget.maxDepth })}
          {value.budget.usdLeft !== undefined && <span>{t('autoloom.usd', { usd: value.budget.usdLeft.toFixed(4) })}</span>}</p>}
        {value.ownTokens !== undefined && <p>{t('autoloom.tokens', { count: value.ownTokens })}</p>}
        {value.timedOut && <p>{t('autoloom.timedOut')}</p>}{value.stoppedByBudget && <p>{t('autoloom.budgetStopped')}</p>}
        {value.archived && <p>{t('autoloom.archived')}</p>}{value.kept && <p>{t('autoloom.kept')}</p>}
        {value.output !== undefined && <pre className={css.output}>{value.output}</pre>}
        <details><summary>{t('autoloom.raw')}</summary><pre className={css.output}>{raw}</pre></details>
      </>}
    </div>}
  </DisclosureRow>
}
