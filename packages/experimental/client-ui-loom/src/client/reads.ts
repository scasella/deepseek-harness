/**
 * The Loom tab's and the branch forms' keyed Remote reads: the compare of a
 * branch point, the diff of one branch, and a branch request's cost estimate.
 * Each key spells the request, so the hook that binds a key needs nothing else.
 */
import type {
  LoomCompareRequest, LoomCompareValue, LoomDiffRequest, LoomDiffValue, LoomPrefixSpan,
} from '@deepseek-ai/dsh-experimental-loom/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createLoomReadSources, type LoomReadSources } from './read-sources.ts'
import type { LoomEstimateRequest, LoomEstimateValue } from '@deepseek-ai/dsh-experimental-loom/types'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'

/** Separator of a key's fields; it cannot occur in a Session id, a path, or a number. */
const FIELD = '\u0000'

/** Remote reads supplied by the owning plugin. */
export interface LoomReadInputs {
  /** `loom.compare`. */
  readonly compare: (request: LoomCompareRequest) => Promise<RemoteResult<LoomCompareValue>>
  /** `loom.diff`. */
  readonly diff: (request: LoomDiffRequest) => Promise<RemoteResult<LoomDiffValue>>
  /** `loom.estimate`. */
  readonly estimate: (request: LoomEstimateRequest) => Promise<RemoteResult<LoomEstimateValue>>
}

/** Keyed read sources of one plugin fiber. */
export interface LoomReads {
  /** Compares keyed by {@link loomCompareKey}. */
  readonly compare: LoomReadSources<LoomCompareValue>
  /** Diffs keyed by {@link loomDiffKey}. */
  readonly diff: LoomReadSources<LoomDiffValue>
  /** Estimates keyed by {@link loomEstimateKey}. */
  readonly estimate: LoomReadSources<LoomEstimateValue>
  /** Close every source. */
  dispose(): void
}

/**
 * Key the compare of the siblings at one Session's cut.
 * @param sessionId - Session whose cut names the siblings; any sibling serves.
 * @returns the key.
 */
export function loomCompareKey(sessionId: SessionId): string {
  return sessionId
}

/**
 * Key the diff of one branch. The version makes a branch that changed more
 * files or lines a new key, so its diff reads again.
 * @param sessionId - the branch.
 * @param path - one file, or null for the whole diff.
 * @param version - the branch's diff totals when the key was built.
 * @returns the key.
 */
export function loomDiffKey(sessionId: SessionId, path: string | null, version: string): string {
  return [sessionId, path ?? '', version].join(FIELD)
}

/**
 * Key one cost estimate by what the estimate depends on.
 * @param request - the estimate request.
 * @returns the key.
 */
export function loomEstimateKey(request: LoomEstimateRequest): string {
  const fields = [request.sessionId, request.kind, request.kind === 'weave' ? '' : request.turn ?? '',
    request.kind === 'weave' ? '' : request.afterTurn ?? '', request.count]
  if (request.selection !== undefined) fields.push(JSON.stringify({
    provider: request.selection.provider, model: request.selection.model,
    ...request.selection.reasoningEffort === undefined ? {} : { reasoningEffort: request.selection.reasoningEffort },
  }))
  else if (request.kind === 'weave') fields.push('')
  if (request.kind === 'weave') fields.push(request.maxTokens ?? '', request.prefix === undefined ? '' : JSON.stringify(request.prefix))
  return fields.join(FIELD)
}

/**
 * Read the request a diff key spells.
 * @param key - a key built by {@link loomDiffKey}.
 * @returns the request.
 */
function diffRequestOf(key: string): LoomDiffRequest {
  const fields = key.split(FIELD)
  const path = fields[1] as string
  return { sessionId: SessionId(fields[0] as string), ...path === '' ? {} : { path } }
}

/**
 * Read the request an estimate key spells.
 * @param key - a key built by {@link loomEstimateKey}.
 * @returns the request.
 */
function estimateRequestOf(key: string): LoomEstimateRequest {
  const fields = key.split(FIELD)
  const turn = fields[2] as string
  const afterTurn = fields[3] as string
  return {
    sessionId: SessionId(fields[0] as string),
    // The key was built from a typed estimate request.
    kind: fields[1] as LoomEstimateRequest['kind'],
    ...turn === '' ? {} : { turn: Number(turn) },
    ...afterTurn === '' ? {} : { afterTurn: Number(afterTurn) },
    count: Number(fields[4]),
    ...fields[5] === undefined || fields[5] === '' ? {} : { selection: JSON.parse(fields[5]) as ModelSelection },
    ...fields[6] === undefined || fields[6] === '' ? {} : { maxTokens: Number(fields[6]) },
    ...fields[7] === undefined || fields[7] === '' ? {} : { prefix: JSON.parse(fields[7]) as readonly LoomPrefixSpan[] },
  }
}

/**
 * Create the keyed read sources of one plugin fiber.
 * @param inputs - the Remote reads.
 * @returns the sources; the caller disposes them with its fiber.
 */
export function createLoomReads(inputs: LoomReadInputs): LoomReads {
  const compare = createLoomReadSources(key => inputs.compare({ sessionId: SessionId(key) }), 'compare')
  const diff = createLoomReadSources(key => inputs.diff(diffRequestOf(key)), 'diff')
  const estimate = createLoomReadSources(key => inputs.estimate(estimateRequestOf(key)), 'estimate')
  return {
    compare,
    diff,
    estimate,
    dispose() {
      compare.dispose()
      diff.dispose()
      estimate.dispose()
    },
  }
}
