/** Main-page catalog of fork families with explicit ownership-scoped content search. */
import { useMemo, useState } from 'react'
import { IconBranchOutlineRegular, IconSearchOutlineRegular, Input, Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LoomReadSources } from './read-sources.ts'
import type { MultiverseSearchValue } from './multiverse.ts'
import { multiverseFamilies, multiverseSearchKey } from './multiverse.ts'
import { sessionTitle } from './lineage.ts'
import type { NS } from './locales.ts'
import css from './MultiversePage.module.css'

/** Catalog navigation and observed targeted-search sources. */
export interface MultiverseInjected {
  keyedHooks: { loomFamilySearch: LoomReadSources<MultiverseSearchValue>['source'] }
  openSession: (sessionId: SessionId) => void
  retrySearch: (key: string) => void
}

/** Main-page runtime, locale, and family-search actions. */
export type MultiversePageProps = PropsRuntime<'main'> & InjectFace<MultiverseInjected> & PropsLocale<typeof NS>

/**
 * Render the cross-Session fork catalog and bounded family content search.
 * @param props - standard list hook, observed search, navigation, and localized labels.
 * @returns the Multiverse page.
 */
export function MultiversePage({ useSessions, useLoomFamilySearch, openSession, retrySearch, t }: MultiversePageProps) {
  const list = useSessions(state => state)
  const families = useMemo(() => multiverseFamilies(list), [list])
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'all' | 'own' | 'inherited'>('own')
  const [selectedRoot, setSelectedRoot] = useState<string>('all')
  const eligible = families.filter(family => selectedRoot === 'all' || family.rootId === selectedRoot)
  const ids = eligible.flatMap(family => family.nodes.map(node => node.sessionId))
  const key = multiverseSearchKey({ query, sessionIds: ids, ...scope === 'all' ? {} : { scope } })
  const result = useLoomFamilySearch(key)
  const hits = new Map(result?.status === 'ready' ? result.value.items.map(item => [item.sessionId, item.snippet]) : [])
  const needle = query.trim().toLowerCase()
  const shown = eligible.filter(family => needle === '' || family.nodes.some(node =>
    sessionTitle(list, node.sessionId).toLowerCase().includes(needle) || hits.has(node.sessionId)))
  return (
    <section className={css.page} aria-label={t('multiverse.title')}>
      <h1>{t('multiverse.title')}</h1>
      <p className={css.description}>{t('multiverse.description')}</p>
      <div className={css.filters}>
        <Input icon={<IconSearchOutlineRegular size={16} />} aria-label={t('multiverse.search')}
          placeholder={t('multiverse.search')} maxLength={500} value={query} onChange={(event) => { setQuery(event.target.value) }} />
        <label>{t('multiverse.family')}<select value={selectedRoot} onChange={(event) => { setSelectedRoot(event.target.value) }}>
          <option value="all">{t('multiverse.allFamilies')}</option>
          {families.map(family => (
            <option key={family.rootId} value={family.rootId}>{sessionTitle(list, SessionId(family.rootId))}</option>
          ))}
        </select></label>
        <label>{t('multiverse.scope')}<select value={scope} onChange={(event) => { setScope(event.target.value as typeof scope) }}>
          <option value="own">{t('multiverse.own')}</option><option value="inherited">{t('multiverse.inherited')}</option>
          <option value="all">{t('multiverse.allHistory')}</option>
        </select></label>
      </div>
      {result?.status === 'failed' && <p role="alert">{t('multiverse.searchFailed')} <Button onClick={() => { retrySearch(key) }}>{t('multiverse.retry')}</Button></p>}
      {needle !== '' && result?.status === 'loading' && <p role="status">{t('multiverse.searching')}</p>}
      {result?.status === 'ready' && result.value.hasMore && <p className={css.description}>{t('multiverse.refine')}</p>}
      {shown.length === 0 && <p>{t(families.length === 0 ? 'multiverse.empty' : 'multiverse.noMatches')}</p>}
      <div className={css.families}>
        {shown.map(family => (
          <section key={family.rootId} className={css.family} aria-label={sessionTitle(list, SessionId(family.rootId))}>
            <h2><IconBranchOutlineRegular size={16} />{sessionTitle(list, SessionId(family.rootId))}
              <span>{t('multiverse.branches', { count: family.nodes.length - 1 })}</span></h2>
            <ul>{family.nodes.map(node => (
              <li key={node.id}><button type="button" className={css.node} onClick={() => { openSession(node.sessionId) }}>
                <span>{node.depth > 0 && <IconBranchOutlineRegular size={14} />}{sessionTitle(list, node.sessionId)}</span>
                {node.running && <span className={css.running}>{t('multiverse.running')}</span>}
                {hits.has(node.sessionId) && <small>{hits.get(node.sessionId)}</small>}
              </button></li>
            ))}</ul>
          </section>
        ))}
      </div>
    </section>
  )
}

/**
 * Render the sidebar's decorative Multiverse glyph.
 * @param props - sidebar-owned icon dimensions and selection.
 * @returns the existing branch glyph.
 */
export function MultiverseIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconBranchOutlineRegular size={size} />
}
