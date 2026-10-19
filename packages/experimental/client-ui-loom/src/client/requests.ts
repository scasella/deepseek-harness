/**
 * React-free sources of `loom.requestAt` reads keyed by `<sessionId>:<seq>`.
 * A source starts its read on the first subscriber and keeps the view while
 * observed; the last unsubscribe aborts a pending read and drops the source,
 * so a later observation reads again. The view binds the sources as
 * `useLoomRequest(key)`.
 */
import { notifySubscribers, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { LoomRequestAtRequest, LoomRequestView } from '@deepseek-ai/dsh-experimental-loom/types'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { keyedSourceRegistry, type KeyedLifecycle } from './keyed-sources.ts'

/** Read state of one step's request. */
export type LoomRequestState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly view: LoomRequestView }
  /** A failed read; `code` is the typed Remote failure, absent when the call itself could not be made. */
  | { readonly status: 'failed'; readonly code?: string }

/** Remote access supplied by the owning plugin. */
export interface LoomRequestInputs {
  /**
   * Read what the model saw for one logged step.
   * @param request - Session and the step's `assistant/message` seq.
   * @param signal - cancellation when the last observer leaves.
   * @returns the request view or a typed Remote failure.
   */
  read(request: LoomRequestAtRequest, signal: AbortSignal): Promise<RemoteResult<LoomRequestView>>
}

/** Keyed request sources owned by one plugin fiber. */
export interface LoomRequestSources {
  /**
   * Return the source of one step's request; a source dropped by its last
   * unsubscribe is replaced by a fresh one that reads again.
   * @param key - `<sessionId>:<seq>`, as {@link loomRequestKey} builds it.
   * @returns the source, stable while observed.
   */
  source(key: string): ObservableSnapshot<LoomRequestState>
  /** Abort every pending read. */
  dispose(): void
}

/**
 * Build the source key of one step's request.
 * @param sessionId - Session holding the step.
 * @param seq - the step's `assistant/message` seq.
 * @returns the key.
 */
export function loomRequestKey(sessionId: SessionId, seq: number): string {
  return `${sessionId}:${String(seq)}`
}

const LOADING: LoomRequestState = Object.freeze({ status: 'loading' })

/**
 * Create request sources over the `loom` Remote.
 * @param inputs - the Remote read.
 * @returns keyed sources; the caller disposes them with its fiber.
 */
export function createLoomRequestSources(inputs: LoomRequestInputs): LoomRequestSources {
  const sources = keyedSourceRegistry((key, lifecycle) => {
    const split = key.lastIndexOf(':')
    const request = { sessionId: SessionId(key.slice(0, split)), seq: SessionSeq(Number(key.slice(split + 1))) }
    return new RequestSource(request, inputs, lifecycle)
  })
  return {
    source: key => sources.get(key),
    dispose() { sources.dispose() },
  }
}

/** One step's request read. */
class RequestSource implements ObservableSnapshot<LoomRequestState> {
  private readonly listeners = new Set<() => void>()
  private state: LoomRequestState = LOADING
  private pending: AbortController | undefined

  constructor(
    private readonly request: LoomRequestAtRequest,
    private readonly inputs: LoomRequestInputs,
    private readonly lifecycle: KeyedLifecycle,
  ) {}

  getSnapshot(): LoomRequestState { return this.state }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      this.lifecycle.active()
      if (this.state.status !== 'ready') this.start()
    }
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return
      this.close()
      this.lifecycle.idle()
    }
  }

  close(): void {
    this.listeners.clear()
    this.pending?.abort()
    this.pending = undefined
  }

  private start(): void {
    const controller = new AbortController()
    this.pending = controller
    if (this.state.status === 'failed') this.publish(LOADING)
    this.inputs.read(this.request, controller.signal).then((result) => {
      if (this.pending !== controller) return
      this.pending = undefined
      this.publish(result.ok ? { status: 'ready', view: result.value } : { status: 'failed', code: result.error.code })
    }, (_error: unknown) => {
      // A rejected call is an assembly fault (the Remote is not mounted); the pane reports the request as unreadable.
      if (this.pending !== controller) return
      this.pending = undefined
      this.publish({ status: 'failed' })
    })
  }

  private publish(state: LoomRequestState): void {
    this.state = state
    notifySubscribers(this.listeners, '[client-ui-loom] request')
  }
}
