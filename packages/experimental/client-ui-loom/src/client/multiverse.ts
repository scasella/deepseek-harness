/** Cross-Session family catalog and targeted content-search keys. */
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { forkFamily, type LoomFamilyRow } from '@deepseek-ai/dsh-experimental-loom/family'
import type { LoomFamily } from '@deepseek-ai/dsh-experimental-loom/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { projectionValuesOf } from './lineage.ts'
import { createLoomReadSources, type LoomReadSources } from './read-sources.ts'

/** Successful content-search page projected by the Session client. */
export type MultiverseSearchValue = Extract<Awaited<ReturnType<ISessions['search']>>, { ok: true }>['value']

/** One family-scoped content query; omitted scope searches both ownership classes. */
export interface MultiverseSearchRequest {
  query: string
  scope?: 'own' | 'inherited'
  sessionIds: readonly SessionId[]
}

/**
 * Derive each listed fork family once, excluding blank and subagent-only rows.
 * @param list - authoritative client Session list and projection hints.
 * @returns fork families containing at least two visible Sessions, newest activity first.
 */
export function multiverseFamilies(list: SessionListState): LoomFamily[] {
  const rows: LoomFamilyRow[] = list.ids.flatMap((id) => {
    const summary = list.byId[id]
    if (summary === undefined || summary.blank || summary.origin === 'subagent') return []
    const lineage = projectionValuesOf(list, id)?.forkLineage
    const parent = lineage?.parentSession ?? summary.parentId
    return [{ sessionId: id, updatedAt: summary.updatedAt, running: summary.running, blank: false,
      ...parent === undefined ? {} : { forkParentId: parent },
      ...lineage === undefined ? {} : { createdAt: lineage.createdAt } }]
  })
  const seen = new Set<SessionId>()
  const families: LoomFamily[] = []
  for (const row of rows) {
    if (seen.has(row.sessionId)) continue
    const family = forkFamily(rows, row.sessionId) as LoomFamily
    for (const node of family.nodes) seen.add(node.sessionId)
    if (family.nodes.length > 1) families.push(family)
  }
  return families.sort((a, b) => Math.max(...b.nodes.map(node => node.updatedAt)) - Math.max(...a.nodes.map(node => node.updatedAt)))
}

/**
 * Encode a typed search request for an observed source.
 * @param request - query, ownership scope, and exact family membership.
 * @returns a stable key with sorted unique target ids.
 */
export function multiverseSearchKey(request: MultiverseSearchRequest): string {
  return JSON.stringify({ ...request, sessionIds: [...new Set(request.sessionIds)].sort() })
}

/**
 * Own targeted content reads outside the page's rendering lifecycle.
 * @param search - Session client's authorized search operation.
 * @returns disposable sources; an empty query returns an empty page without a Remote call.
 */
export function createMultiverseSearch(search: ISessions['search']): LoomReadSources<MultiverseSearchValue> {
  return createLoomReadSources<MultiverseSearchValue>((key) => {
    const request = JSON.parse(key) as MultiverseSearchRequest
    if (request.query.trim() === '') return Promise.resolve({ ok: true, value: { items: [], hasMore: false } })
    return search(request.query, new AbortController().signal, request.scope, request.sessionIds)
  }, 'loom-multiverse-search')
}
