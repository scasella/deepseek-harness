/** Auxiliary prose generation and choices, independent of the Chat message surface. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  AssistantStreamAccumulator, errorChain, isTokenDelta, LlmError, ReasoningEffortId,
  type GenerateOptions, type PreparedLlmCall,
} from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, type SessionId, type SessionSeq } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { inspectSession } from './inspect.ts'
import { readWeaveDocument, validPrefixSpan } from './weave-records.ts'
import type {
  LoomChooseRequest, LoomCurationValue, LoomNodeId, LoomPrefixSpan, LoomProbeNode, LoomProbeRequest, LoomProbeValue,
  LoomWeaveRequest, LoomWeaveRequestRecord, LoomWeaveState, LoomWeaveValue, LoomProseUnavailableReason,
} from './types.ts'

/** Deployment limits and defaults for prose generation. */
export interface LoomWeaveConfig {
  /** Largest sibling count per prose request. Default 4; at most 16. */
  readonly maxSiblings?: number
  /** Default and upper bound of output tokens per sibling. Default 200. */
  readonly maxTokens?: number
  /** Default sampling temperature, from 0 through 2. Default 1. */
  readonly temperature?: number
  /** Default captured alternatives per token, from 0 through 20. Default 10. */
  readonly topLogprobs?: number
  /** Milliseconds after the lead's first token before starting siblings. Default 1500. */
  readonly leadDelayMs?: number
  /** Whole prose operation timeout in milliseconds, probes included. Default 120000. */
  readonly timeoutMs?: number
  /** Milliseconds a successful identical prefix remains eligible for a direct burst. Default 3600000. */
  readonly warmWindowMs?: number
  /** Largest joined prose prefix in Unicode code points. Default 262144. */
  readonly maxPrefixCodePoints?: number
  /** Exact model-visible prose instructions, logged before dispatch. */
  readonly framing?: {
    /** System instructions for the auxiliary prose call. */
    readonly system: string
    /** User-role instruction preceding the assistant prefix. */
    readonly user: string
  }
}

/** Deployment limits for breadth-first next-token exploration. */
export interface LoomProbeConfig {
  /** Largest token depth callers may request. Default 4. */
  readonly maxDepth?: number
  /** Smallest cumulative probability explored; callers may choose a higher cutoff. Default 0.02. */
  readonly cutoff?: number
  /** Largest number of provider calls in one breadth-first probe. Default 32. */
  readonly maxRequests?: number
  /** Captured next-token alternatives per probe request, from 1 through 20. Default 20. */
  readonly topLogprobs?: number
}

/** Fully resolved prose configuration. */
export interface LoomProseConfig {
  readonly weave: Required<LoomWeaveConfig>
  readonly probe: Required<LoomProbeConfig>
}

interface WeaveSpec {
  readonly request: LoomWeaveRequestRecord
  readonly call: PreparedLlmCall
  readonly cacheKey: string
}

/** Fail a prose operation with an actionable Session-scoped error. */
function unavailable(sessionId: SessionId, reason: string, reasonCode: LoomProseUnavailableReason = 'provider'): RemoteError<'loom/prose-unavailable'> {
  return new RemoteError('loom/prose-unavailable', reason, { sessionId, reason, reasonCode })
}

/** Wait for a configured lead delay, releasing its timer and abort listener at settlement. */
function leadDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      const reason: unknown = signal.reason
      reject(reason instanceof Error ? reason : new Error(String(reason)))
    }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Lifecycle owner of prose calls, configured cache warming, and durable selections. */
export class LoomProse {
  private readonly owner = new AbortController()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly warmPrefixes = new Map<string, number>()

  /**
   * @param ctx - Loom Host context owning all calls and their Sessions.
   * @param config - validated deployment limits and defaults.
   */
  constructor(private readonly ctx: Context, private readonly config: LoomProseConfig) {
    ctx.effect(() => async () => {
      this.owner.abort(new Error('The Loom service unloaded.'))
      await Promise.allSettled([...this.tasks])
      this.warmPrefixes.clear()
    }, 'loom.prose')
  }

  /**
   * Generate all requested siblings and retain every settled stream.
   * @param request - cursor, authored prefix and per-request controls.
   * @param signal - caller cancellation.
   * @returns siblings in dispatch order, including canceled and failed ones.
   */
  weave(request: LoomWeaveRequest, signal: AbortSignal): Promise<LoomWeaveValue> {
    return this.perform(request.sessionId, signal, (agent, operation) => this.generate(agent, request, 'weave', operation))
  }

  /**
   * Read a prose document without activating a cold Agent.
   * @param sessionId - Session whose prose records to read.
   * @param signal - caller cancellation.
   * @returns validated nodes and current curation totals.
   */
  async state(sessionId: SessionId, signal: AbortSignal): Promise<LoomWeaveState> {
    return readWeaveDocument((await inspectSession(this.ctx, sessionId, signal)).events).state
  }

  /**
   * Select one settled prose sibling; choosing again in the same set replaces
   * the prior choice's credit instead of adding credit for repeated clicks.
   * @param request - chosen node in the addressed Session.
   * @param signal - caller cancellation.
   * @returns curation bits and selected model-token count.
   */
  choose(request: LoomChooseRequest, signal: AbortSignal): Promise<LoomCurationValue> {
    return this.perform(request.sessionId, signal, async (agent, operation) => {
      const state = await this.state(agent.id, operation)
      const chosen = state.nodes.find(node => node.id === request.nodeId && node.kind === 'weave' && node.status === 'completed')
      if (chosen === undefined) throw new RemoteError('loom/node-not-found', 'Select a completed prose continuation.', request)
      if (state.choices.some(choice => choice.nodeId === chosen.id)) {
        return { curationBits: state.curationBits, modelTokens: state.modelTokens }
      }
      const siblings = state.nodes.filter(node => node.requestSeq === chosen.requestSeq && node.status === 'completed')
      appendPluginRecord(agent.session, 'plugin:loom/choice', {
        version: 1, nodeId: chosen.id, requestSeq: chosen.requestSeq, alternatives: siblings.length,
      })
      await this.ctx.sessions.flush(agent.session)
      const latest = await this.state(agent.id, operation)
      return { curationBits: latest.curationBits, modelTokens: latest.modelTokens }
    })
  }

  /**
   * Explore the most likely next tokens breadth-first within request and depth limits.
   * @param request - cursor and optional tighter exploration controls.
   * @param signal - caller cancellation.
   * @returns token alternatives and whether the request budget stopped expansion.
   */
  probe(request: LoomProbeRequest, signal: AbortSignal): Promise<LoomProbeValue> {
    const depth = request.depth ?? this.config.probe.maxDepth
    const cutoff = request.cutoff ?? this.config.probe.cutoff
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > this.config.probe.maxDepth
      || !Number.isFinite(cutoff) || cutoff < this.config.probe.cutoff || cutoff > 1) {
      return Promise.reject(unavailable(request.sessionId, 'Probe depth and cutoff must stay within the configured limits.', 'limits'))
    }
    return this.perform(request.sessionId, signal, async (agent, operation) => {
      const nodes: LoomProbeNode[] = []
      const positions: NonNullable<LoomProbeValue['positions']>[number][] = []
      const queue: { parent: LoomProbeNode['id'] | null; prefix: readonly LoomPrefixSpan[]; probability: number; depth: number }[] = [
        { parent: null, prefix: request.prefix, probability: 1, depth: 0 },
      ]
      let requests = 0
      while (queue.length > 0 && requests < this.config.probe.maxRequests) {
        operation.throwIfAborted()
        const position = queue.shift()
        /* v8 ignore next -- the loop condition and synchronous shift establish a queued item */
        if (position === undefined) break
        const generated = await this.generate(agent, {
          sessionId: request.sessionId, parent: request.parent, prefix: position.prefix, n: 1,
          controls: { maxTokens: 1, topLogprobs: this.config.probe.topLogprobs },
          ...request.route === undefined ? {} : { route: request.route },
        }, 'probe', operation)
        requests++
        const sampled = generated.nodes[0]
        const alternatives = sampled?.logprobs?.top[0]
        if (sampled === undefined || alternatives === undefined || sampled.status !== 'completed') {
          throw unavailable(agent.id, 'The selected model did not return next-token probabilities. Choose a model that supports token probabilities.', 'unsupported-logprobs')
        }
        positions.push({ parent: position.parent, sourceNodeId: sampled.id })
        for (const [index, alternative] of alternatives.entries()) {
          const probability = Math.exp(alternative.logprob)
          const cumulativeProbability = position.probability * probability
          if (cumulativeProbability < cutoff) continue
          const id = brandString<LoomProbeNode['id']>(`${sampled.id}:alternative:${String(index)}`)
          const nextDepth = position.depth + 1
          nodes.push({ id, parent: position.parent, token: alternative.token, sourceNodeId: sampled.id, tokenIndex: 0,
            probability, cumulativeProbability, depth: nextDepth })
          if (nextDepth < depth) queue.push({
            parent: id, probability: cumulativeProbability, depth: nextDepth,
            prefix: [...position.prefix, { text: alternative.token, author: 'alternative', node: sampled.id, tokenIndex: 0 }],
          })
        }
      }
      return { nodes, positions, requests, truncated: queue.length > 0 }
    })
  }

  private perform<T>(sessionId: SessionId, signal: AbortSignal, task: (agent: Agent, signal: AbortSignal) => Promise<T>): Promise<T> {
    const operation = AbortSignal.any([signal, this.owner.signal, AbortSignal.timeout(this.config.weave.timeoutMs)])
    const promise = (async () => {
      operation.throwIfAborted()
      const resolved = await this.ctx.sessionController.resolveAgent(sessionId)
      if ('error' in resolved) throw resolved.error
      operation.throwIfAborted()
      const activity = { entered: false }
      try {
        return await resolved.agent.runMaintenance((maintenance) => {
          activity.entered = true
          return task(resolved.agent, AbortSignal.any([operation, maintenance]))
        })
      } catch (error: unknown) {
        if (error instanceof RemoteError) throw error
        throw unavailable(sessionId, `The prose operation stopped: ${errorChain(error)}`,
          operation.aborted ? 'cancelled' : activity.entered ? 'provider' : 'busy')
      }
    })()
    this.tasks.add(promise)
    void promise.then(() => this.tasks.delete(promise), () => this.tasks.delete(promise))
    return promise
  }

  private async resolve(agent: Agent, request: LoomWeaveRequest, kind: LoomWeaveRequestRecord['kind'], signal: AbortSignal): Promise<WeaveSpec> {
    const limits = this.config.weave
    const controls = request.controls
    const maxTokens = controls?.maxTokens ?? limits.maxTokens
    const temperature = controls?.temperature ?? limits.temperature
    const topLogprobs = controls?.topLogprobs ?? limits.topLogprobs
    const stop = controls?.stop ?? []
    const assistantPrefix = request.prefix.map(span => span.text).join('')
    if (!Number.isSafeInteger(request.n) || request.n < 1 || request.n > limits.maxSiblings
      || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > limits.maxTokens
      || !Number.isFinite(temperature) || temperature < 0 || temperature > 2
      || !Number.isSafeInteger(topLogprobs) || topLogprobs < 0 || topLogprobs > 20
      || Array.from(assistantPrefix).length > limits.maxPrefixCodePoints || stop.some(value => value.length === 0)) {
      throw unavailable(agent.id, 'Prose controls exceed the configured sibling, output, prefix, or sampling limits.', 'limits')
    }
    const document = readWeaveDocument((await inspectSession(this.ctx, agent.id, signal)).events)
    if (request.parent !== null && !document.state.nodes.some(node => node.id === request.parent)) {
      throw new RemoteError('loom/node-not-found', 'The prose cursor no longer names a recorded node.', { sessionId: agent.id, nodeId: request.parent })
    }
    for (const span of request.prefix) {
      if (!validPrefixSpan(span, document.state.nodes)) throw unavailable(agent.id, 'An authored prefix span does not match its recorded model text or alternative token.', 'prefix')
    }
    const selection = this.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
    const route = request.route ?? selection?.pending ?? selection?.lastUsed ?? agent.session.requestHeader()?.config ?? agent.options
    if (route.provider === undefined || route.model === undefined) throw unavailable(agent.id, 'Select a provider and model before generating prose.', 'route')
    const model = await this.ctx.llm.resolveModelInfo(route.provider, route.model)
    if (assistantPrefix.length > 0 && model.assistantPrefill !== 'tool-free') {
      throw unavailable(agent.id, 'Select a model route that supports tool-free assistant prefixes.', 'unsupported-prefix')
    }
    if (topLogprobs > 0 && (model.tokenLogprobs === undefined || topLogprobs > model.tokenLogprobs.maxTopLogprobs)) {
      throw unavailable(agent.id, 'Select a model route that supports the requested token alternatives, or reduce their count.', 'unsupported-logprobs')
    }
    const call = await this.ctx.llm.prepareCall({
      provider: route.provider, model: route.model, maxTokens, temperature, topLogprobs,
      ...stop.length === 0 ? {} : { stop: [...stop] },
      ...model.reasoning === undefined ? {} : { reasoningEffort: ReasoningEffortId('off') },
    }, signal)
    const framing = limits.framing
    const cacheKey = createHash('sha256').update(JSON.stringify([call.config.provider, call.config.model, framing, assistantPrefix])).digest('hex')
    const now = Date.now()
    for (const [key, settledAt] of this.warmPrefixes) if (now - settledAt >= limits.warmWindowMs) this.warmPrefixes.delete(key)
    const schedule = this.warmPrefixes.has(cacheKey) || request.n === 1 ? 'burst' : 'lead-then-burst'
    return {
      call, cacheKey,
      request: {
        version: 1, parentNode: request.parent, n: request.n, config: call.config, topLogprobs,
        system: framing.system, messages: [{ role: 'user', content: [{ type: 'text', text: framing.user }] }],
        assistantPrefix, prefixSpans: request.prefix, stop, schedule, kind,
      },
    }
  }

  private async generate(agent: Agent, request: LoomWeaveRequest, kind: LoomWeaveRequestRecord['kind'], signal: AbortSignal): Promise<LoomWeaveValue> {
    const spec = await this.resolve(agent, request, kind, signal)
    signal.throwIfAborted()
    const requestSeq = appendPluginRecord(agent.session, 'plugin:loom/weave-request', spec.request)
    const lead = Promise.withResolvers<void>()
    const group = new AbortController()
    const generationSignal = AbortSignal.any([signal, group.signal])
    const failures: unknown[] = []
    const run = (index: number): Promise<LoomNodeId | undefined> => this.streamNode(
      agent, spec, requestSeq, index, generationSignal, lead.resolve,
    )
      .catch((error: unknown) => { failures.push(error); group.abort(error); return undefined })
    const running = [run(0)]
    if (spec.request.schedule === 'lead-then-burst') {
      await lead.promise
      try {
        await leadDelay(this.config.weave.leadDelayMs, generationSignal)
      } catch (_canceledLeadDelay) {
        // Every unstarted sibling still records a canceled settlement below.
      }
    }
    if (failures.length === 0) for (let index = 1; index < request.n; index++) running.push(run(index))
    await Promise.all(running)
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Prose settlements could not be recorded. Inspect this Session before generating again.')
    }
    await this.ctx.sessions.flush(agent.session)
    const nodes = (await this.state(agent.id, new AbortController().signal)).nodes.filter(node => node.requestSeq === requestSeq)
    if (nodes.some(node => node.status === 'completed')) this.warmPrefixes.set(spec.cacheKey, Date.now())
    return { requestSeq, schedule: spec.request.schedule, nodes }
  }

  private async streamNode(
    agent: Agent,
    spec: WeaveSpec,
    requestSeq: SessionSeq,
    index: number,
    signal: AbortSignal,
    firstToken: () => void,
  ): Promise<LoomNodeId> {
    const accumulator = new AssistantStreamAccumulator()
    let settled = false
    try {
      signal.throwIfAborted()
      const request = spec.request
      const call = index === 0 ? spec.call : await this.ctx.llm.prepareCall(request.config, signal)
      const options: GenerateOptions = {
        ...spec.call.config, system: request.system,
        messages: request.messages.map(message => ({ role: message.role, content: [...message.content] })),
        sessionId: agent.id, cacheSessionId: agent.id, signal,
        ...request.assistantPrefix.length === 0 ? {} : { assistantPrefix: request.assistantPrefix },
        ...request.stop.length === 0 ? {} : { stop: [...request.stop] },
      }
      for await (const chunk of call.stream(options)) {
        accumulator.push({ time: Date.now(), chunk })
        if (isTokenDelta(chunk)) firstToken()
        if (chunk.type === 'finish') settled = true
      }
      if (!settled) accumulator.push({ time: Date.now(), chunk: { type: 'finish', reason: {
        kind: 'error', failure: { code: 'UNKNOWN', message: 'The prose stream ended without a finish record.' },
      } } })
    } catch (error: unknown) {
      if (!settled) accumulator.push({ time: Date.now(), chunk: { type: 'finish', reason: {
        kind: signal.aborted ? 'aborted' : 'error',
        failure: error instanceof LlmError ? error.failure : { code: signal.aborted ? 'ABORTED' : 'UNKNOWN', message: errorChain(error) },
      } } })
    } finally {
      firstToken()
    }
    const id = brandString<LoomNodeId>(`weave:${agent.id}:${String(requestSeq)}:${String(index)}`)
    appendPluginRecord(agent.session, 'plugin:loom/weave-node', {
      version: 1, id, requestSeq, index, kind: spec.request.kind, stream: accumulator.snapshot(),
    })
    return id
  }
}
