/**
 * Pure reading of the running-branches strip of one Session: every child of
 * the branch sets the Session started or branched, with its state, and the
 * sets found running in the family that the browser does not follow yet.
 * A queued child turns into its Session as soon as the family lists a member
 * whose `loomBranch` names the same set and index.
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { LoomFamily, LoomSetId } from '@deepseek-ai/dsh-experimental-loom/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { LoomTrackedChild, LoomTrackedSet } from './branching.ts'
import { branchOf, projectionValuesOf } from './lineage.ts'

/** What one strip item shows about its child. */
export type LoomStripStatus = 'running' | 'approval' | 'done' | 'queued' | 'failed' | 'not-started'

/** One child in the strip. */
export interface LoomStripItem {
  readonly setId: LoomSetId
  /** Zero-based request index. */
  readonly index: number
  /** Prompt line of the child, when its set named one per child. */
  readonly line?: string
  /** Child Session, once one exists. */
  readonly sessionId?: SessionId
  readonly status: LoomStripStatus
  /** RemoteError code of a failed child. */
  readonly code?: string
}

/** One set the strip shows, with what the browser can do with it. */
export interface LoomStripSet {
  readonly setId: LoomSetId
  readonly items: readonly LoomStripItem[]
  /**
   * Changes whenever a child of a set with queued children starts, ends, or
   * needs approval, so the strip reads the set's status again exactly then.
   * Absent for a set without queued children.
   */
  readonly refreshKey?: string
  /**
   * Changes after each status read of a set that waits for a queued child
   * while none of its children runs or needs approval. The Host may then be
   * forking the next child, and a fork that fails before the child has a
   * Session changes nothing else the strip sees, so the strip reads the set
   * again after a pause. Absent otherwise.
   */
  readonly pollKey?: string
  /** Whether the set still runs or waits; a set with only ended children and failures waits for dismissal. */
  readonly active: boolean
}

/** Totals over the shown children. */
export interface LoomStripCounts {
  readonly running: number
  readonly queued: number
  readonly approval: number
  readonly failed: number
}

/** The strip of one Session. */
export interface LoomStrip {
  /** Sets with at least one running, waiting, queued, or failed child. */
  readonly sets: readonly LoomStripSet[]
  readonly counts: LoomStripCounts
  /** Sets whose children run in the family but that the browser does not follow. */
  readonly untracked: readonly { readonly setId: LoomSetId; readonly sourceSessionId: SessionId }[]
}

/** Inputs of {@link stripOf}. */
export interface LoomStripInput {
  /** Session whose dock shows the strip. */
  readonly sessionId: SessionId
  readonly sets: readonly LoomTrackedSet[]
  /** The Session's fork family, when it has loaded. */
  readonly family: LoomFamily | undefined
  readonly list: SessionListState
  readonly statuses: SessionStatusSnapshot
}

/** A listed family member's branch facts. */
interface Member {
  readonly sessionId: SessionId
  readonly setId: LoomSetId
  readonly index: number
}

/**
 * Read the status a started child shows.
 * @param sessionId - child Session.
 * @param input - list and live status.
 * @returns running, approval, or done.
 */
function liveStatus(sessionId: SessionId, input: LoomStripInput): 'running' | 'approval' | 'done' {
  const status = input.statuses.get(sessionId)
  if (status?.pendingInteraction !== undefined) return 'approval'
  return (status?.running ?? input.list.byId[sessionId]?.running) === true ? 'running' : 'done'
}

/**
 * Read one child's strip item, or none for a withdrawn child.
 * @param set - its set.
 * @param index - the child's request index.
 * @param child - tracked facts, if the browser has any.
 * @param member - the listed family member holding the same set and index, if any.
 * @param input - list and live status.
 * @returns the item, or undefined.
 */
function itemOf(
  set: LoomTrackedSet,
  index: number,
  child: LoomTrackedChild | undefined,
  member: Member | undefined,
  input: LoomStripInput,
): LoomStripItem | undefined {
  const sessionId = child?.sessionId ?? member?.sessionId
  const line = set.lines[index]
  const base = { setId: set.setId, index, ...line === undefined ? {} : { line } }
  if (child?.state === 'cancelled') return undefined
  if (child?.code !== undefined) {
    return { ...base, ...sessionId === undefined ? {} : { sessionId }, status: 'failed', code: child.code }
  }
  if (sessionId !== undefined) return { ...base, sessionId, status: liveStatus(sessionId, input) }
  // A started child names its Session and a failed one its code, so a child with neither still waits.
  return { ...base, status: set.lost ? 'not-started' : 'queued' }
}

/**
 * Read the strip of one Session.
 * @param input - Session, followed sets, family, list, and live status.
 * @returns the shown sets, their totals, and the running sets to follow.
 */
export function stripOf(input: LoomStripInput): LoomStrip {
  const { sessionId, family, list } = input
  const members = new Map<LoomSetId, Member[]>()
  const parentNode = family?.nodes.find(node => node.sessionId === sessionId)?.id
  for (const node of family?.nodes ?? []) {
    const branch = branchOf(projectionValuesOf(list, node.sessionId))
    if (branch === undefined) continue
    const member: Member = { sessionId: node.sessionId, setId: branch.setId, index: branch.index }
    const known = members.get(branch.setId)
    if (known === undefined) members.set(branch.setId, [member])
    else known.push(member)
  }
  const followed = input.sets.filter(set => set.sourceSessionId === sessionId || set.ownerSessionId === sessionId)
  const sets: LoomStripSet[] = []
  const counts = { running: 0, queued: 0, approval: 0, failed: 0 }
  for (const set of followed) {
    const listed = members.get(set.setId) ?? []
    const indices = [...new Set([...set.children.map(child => child.index), ...listed.map(member => member.index)])].sort((a, b) => a - b)
    const items = indices.flatMap((index) => {
      const child = set.children.find(candidate => candidate.index === index)
      const item = itemOf(set, index, child, listed.find(member => member.index === index), input)
      return item === undefined ? [] : [item]
    })
    const active = items.some(item => item.status === 'running' || item.status === 'approval' || item.status === 'queued')
    if (!active && !items.some(item => item.status === 'failed')) continue
    for (const item of items) {
      if (item.status === 'running' || item.status === 'queued' || item.status === 'approval' || item.status === 'failed') counts[item.status] += 1
    }
    const waiting = set.children.some(child => child.state === 'queued' && child.sessionId === undefined) && !set.lost
    const idle = !items.some(item => item.status === 'running' || item.status === 'approval')
    sets.push({
      setId: set.setId,
      items,
      active,
      ...waiting ? { refreshKey: items.map(item => `${String(item.index)}:${item.status}`).join(',') } : {},
      ...waiting && idle ? { pollKey: `${set.setId}#${String(set.reads)}` } : {},
    })
  }
  const followedIds = new Set(input.sets.map(set => set.setId))
  const untracked: { setId: LoomSetId; sourceSessionId: SessionId }[] = []
  for (const [setId, listed] of members) {
    if (followedIds.has(setId)) continue
    const node = family?.nodes.find(candidate => candidate.sessionId === listed[0]?.sessionId)
    if (node?.parentId === undefined || node.parentId !== parentNode) continue
    if (listed.some(member => liveStatus(member.sessionId, input) !== 'done')) untracked.push({ setId, sourceSessionId: sessionId })
  }
  return { sets, counts, untracked }
}
