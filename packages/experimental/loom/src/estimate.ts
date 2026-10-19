/** List-price previews from recorded branch or prose usage, with explicit output caps for prose. */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { TokenUsageBuckets } from '@deepseek-ai/dsh-token-meter/client'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { resolveEstimate } from './branch-spec.ts'
import { forkFamily } from './family.ts'
import { inspectSession } from './inspect.ts'
import { priceKey, priceOf, settlementUsage } from './pricing.ts'
import { isSettlement, nextRouteAt } from './route.ts'
import { readWeaveDocument } from './weave-records.ts'
import type { LoomEstimateRange, LoomEstimateRequest, LoomEstimateValue, LoomPrefixSpan, LoomPriceRow, LoomWeaveEstimateRequest } from './types.ts'

/** Deployment limits shared by Weave generation and its price previews. */
export interface LoomWeaveEstimatePolicy {
  readonly maxSiblings: number
  readonly maxTokens: number
}

/** Tokens of one branch in the buckets a price row charges for, averaged when they come from several turns. */
export interface EstimateBasis {
  /** Input tokens the provider did not serve from cache, cache writes included. */
  readonly miss: number
  /** Input tokens served from cache. */
  readonly hit: number
  /** Output tokens, reasoning tokens included. */
  readonly output: number
}

/** One fork family member's own usage and the number of own turns it came from. */
export interface FamilyMember {
  /** Token buckets of the requests the member sent itself. */
  readonly usage: TokenUsageBuckets
  /** Turns the member ran itself. */
  readonly turns: number
}

/**
 * A basis, or undefined when it holds no tokens at all.
 * @param basis - the candidate.
 * @returns the basis when it holds tokens.
 */
function withTokens(basis: EstimateBasis): EstimateBasis | undefined {
  return basis.miss + basis.hit + basis.output === 0 ? undefined : basis
}

/**
 * Tokens one turn used: the sum over every request settlement of the turn,
 * failed attempts included, because the provider billed them.
 * @param events - complete log.
 * @param turn - the turn.
 * @returns the turn's tokens, or undefined when none of its settlements reported usage.
 */
export function turnBasis(events: readonly SessionEvent[], turn: number): EstimateBasis | undefined {
  let reported = false
  let miss = 0
  let hit = 0
  let output = 0
  for (const event of events) {
    if (!isSettlement(event) || event.data.turn !== turn) continue
    const usage = settlementUsage(event)
    if (usage === undefined) continue
    reported = true
    miss += usage.inputTokens + (usage.cacheWriteTokens ?? 0)
    hit += usage.cacheReadTokens ?? 0
    output += usage.outputTokens
  }
  return reported ? withTokens({ miss, hit, output }) : undefined
}

/**
 * Tokens of the average own turn of a fork family: the members' own usage
 * summed and divided by their own turns. A member with no own turn adds nothing.
 * @param members - the family's members.
 * @returns the average turn, or undefined when no member ran a turn or no turn used tokens.
 */
export function familyBasis(members: readonly FamilyMember[]): EstimateBasis | undefined {
  let turns = 0
  let miss = 0
  let hit = 0
  let output = 0
  for (const { usage, turns: own } of members) {
    if (own === 0) continue
    turns += own
    miss += usage.uncachedInputTokens + usage.cacheWriteTokens
    hit += usage.cacheReadTokens
    output += usage.outputTokens
  }
  return turns === 0 ? undefined : withTokens({ miss: miss / turns, hit: hit / turns, output: output / turns })
}

/**
 * The range of a branch's cost on a priced route: every input token at the
 * cache-hit price, and every one at the cache-miss price.
 * @param row - the route's prices.
 * @param basis - the branch's tokens.
 * @returns low and high dollars.
 */
function dollars(row: LoomPriceRow, basis: EstimateBasis): LoomEstimateRange {
  const input = basis.miss + basis.hit
  const warm = priceOf(row, { uncachedInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: input, outputTokens: basis.output })
  const cold = priceOf(row, { uncachedInputTokens: input, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: basis.output })
  return { low: Math.min(warm, cold), high: Math.max(warm, cold) }
}

/**
 * Cost preview of a branch request.
 * @param basis - the tokens one branch would use, or undefined when no usage is recorded.
 * @param source - where the basis came from.
 * @param count - children the request would create.
 * @param row - the route's configured prices, or undefined for an unpriced route.
 * @returns the preview: dollars for a priced route, tokens for an unpriced one, and no ranges without a basis.
 */
export function estimateValue(
  basis: EstimateBasis | undefined,
  source: LoomEstimateValue['basis'],
  count: number,
  row: LoomPriceRow | undefined,
): LoomEstimateValue {
  const priced = row !== undefined
  if (basis === undefined) return { priced, cacheShare: 0, basis: source }
  const input = basis.miss + basis.hit
  const tokens = input + basis.output
  const perBranch = row === undefined ? { low: tokens, high: tokens } : dollars(row, basis)
  return {
    priced,
    perBranch,
    total: { low: perBranch.low * count, high: perBranch.high * count },
    cacheShare: input === 0 ? 0 : basis.hit / input,
    basis: source,
  }
}

/**
 * Select reported own prose input usage, preferring the exact cursor prefix and otherwise the latest request on its route.
 * @param events - complete Session log, including inherited attribution sources.
 * @param inheritedEventCount - events inherited from the fork source; their requests cannot supply own usage.
 * @param selection - provider/model that the preview prices.
 * @param prefix - current authored cursor prefix, when supplied.
 * @param outputCap - full output limit used for the preview.
 * @returns historical input and its recorded source, or undefined without reported own usage on that route.
 */
export function weaveBasis(
  events: readonly SessionEvent[],
  inheritedEventCount: number,
  selection: ModelSelection,
  prefix: readonly LoomPrefixSpan[] | undefined,
  outputCap: number,
): { readonly basis: EstimateBasis; readonly historicalInput: NonNullable<LoomEstimateValue['historicalInput']> } | undefined {
  const document = readWeaveDocument(events)
  const text = prefix?.map(span => span.text).join('')
  let latest: ReturnType<typeof weaveBasis>
  let matching: ReturnType<typeof weaveBasis>
  for (const [requestSeq, request] of document.requests) {
    if (requestSeq < inheritedEventCount || request.kind !== 'weave'
      || request.config.provider !== selection.provider || request.config.model !== selection.model) continue
    const samples = document.state.nodes.filter(node => node.requestSeq === requestSeq).flatMap((node) => {
      const usage = node.usage
      return usage === undefined
        || usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens === 0 ? [] : [usage]
    })
    if (samples.length === 0) continue
    const miss = samples.reduce((sum, usage) => sum + usage.inputTokens + (usage.cacheWriteTokens ?? 0), 0) / samples.length
    const hit = samples.reduce((sum, usage) => sum + (usage.cacheReadTokens ?? 0), 0) / samples.length
    const value = {
      basis: { miss, hit, output: outputCap },
      historicalInput: {
        requestSeq, samples: samples.length, provider: request.config.provider, model: request.config.model,
        prefixMatches: request.assistantPrefix === text,
      },
    }
    latest = value
    if (value.historicalInput.prefixMatches) matching = value
  }
  return matching ?? latest
}

/** Reads cost previews without activating Agents or creating branch sets. */
export class LoomEstimator {
  /**
   * @param ctx - Loom Host context.
   * @param maxBranches - configured branch count limit.
   * @param prices - validated list prices, fixed for the plugin lifetime.
   * @param weave - configured prose count and output limits; omission makes prose estimates unavailable.
   */
  constructor(
    private readonly ctx: Context,
    private readonly maxBranches: number,
    private readonly prices: ReadonlyMap<string, LoomPriceRow>,
    private readonly weave?: LoomWeaveEstimatePolicy,
  ) {}

  /**
   * Estimate a repeated/family turn, or historical prose input at the requested output cap.
   * @param request - addressed Session, operation, sibling count, and turn or prose controls.
   * @param visible - whether the caller may read each family member.
   * @param signal - cancellation of Session and projection reads.
   * @returns dollars at configured list prices, or token figures for an unpriced route.
   * @throws RemoteError `session/not-found`, branch turn/count validation failures, or `gateway/internal` without own usage projections.
   */
  async estimate(request: LoomEstimateRequest, visible: (id: SessionId) => boolean, signal: AbortSignal): Promise<LoomEstimateValue> {
    const source = await inspectSession(this.ctx, request.sessionId, signal)
    if (request.kind === 'weave') return this.weaveEstimate(request, source.events, source.inheritedEventCount, signal)
    const spec = resolveEstimate(request, source, this.maxBranches)
    let basis = request.kind === 'regenerate' || request.kind === 'edit' ? turnBasis(source.events, spec.turn) : undefined
    const origin = basis === undefined ? 'family' : 'own-turn'
    if (basis === undefined) basis = await this.familyBasis(request, visible, signal)
    signal.throwIfAborted()
    const row = spec.selection === undefined ? undefined : this.prices.get(priceKey(spec.selection.provider, spec.selection.model))
    return estimateValue(basis, origin, request.count, row)
  }

  private weaveEstimate(
    request: LoomWeaveEstimateRequest,
    events: readonly SessionEvent[],
    inheritedEventCount: number,
    signal: AbortSignal,
  ): LoomEstimateValue {
    const policy = this.weave
    const outputCap = request.maxTokens ?? policy?.maxTokens
    if (policy === undefined || !Number.isSafeInteger(request.count) || request.count < 1 || request.count > policy.maxSiblings
      || outputCap === undefined || !Number.isSafeInteger(outputCap) || outputCap < 1 || outputCap > policy.maxTokens) {
      const reason = 'Prose preview count and output tokens must stay within the configured Weave limits.'
      throw new RemoteError('loom/prose-unavailable', reason, { sessionId: request.sessionId, reason, reasonCode: 'limits' })
    }
    const selection = request.selection ?? nextRouteAt(events, events.length - 1)
    const evidence = selection === undefined ? undefined : weaveBasis(events, inheritedEventCount, selection, request.prefix, outputCap)
    const row = selection === undefined ? undefined : this.prices.get(priceKey(selection.provider, selection.model))
    signal.throwIfAborted()
    return {
      ...estimateValue(evidence?.basis, 'weave-history', request.count, row), outputCap,
      ...evidence === undefined ? {} : { historicalInput: evidence.historicalInput },
    }
  }

  private async familyBasis(
    request: LoomEstimateRequest,
    visible: (id: SessionId) => boolean,
    signal: AbortSignal,
  ): Promise<EstimateBasis | undefined> {
    const { items } = await this.ctx.sessionController.list({}, signal)
    const rows = items.filter(item => item.sessionId === request.sessionId || visible(item.sessionId)).map(item => ({
      sessionId: item.sessionId,
      ...item.origin === 'subagent' || item.parentSessionId === undefined ? {} : { forkParentId: item.parentSessionId },
      updatedAt: item.updatedAt,
      running: item.running,
      blank: item.blank,
    }))
    const family = forkFamily(rows, request.sessionId)
    const members: FamilyMember[] = []
    for (const node of family?.nodes ?? []) {
      try {
        const values = (await this.ctx.sessionController.projections({ sessionId: node.sessionId }, signal))?.values
        const usage = values?.tokenUsage?.fork?.own ?? values?.tokenUsage
        const turns = (values?.sessionStats?.fork?.own ?? values?.sessionStats)?.turns
        if (usage === undefined || turns === undefined) {
          throw new RemoteError('gateway/internal', `loom.estimate cannot read own usage of session "${node.sessionId}": the tokenUsage and sessionStats projections are unavailable`, {})
        }
        members.push({ usage, turns })
      } catch (error) {
        if (remoteErrorOf(error)?.code !== 'session/not-found') throw error
        // A family member may be removed between the list and its projection read.
      }
    }
    return familyBasis(members)
  }
}
