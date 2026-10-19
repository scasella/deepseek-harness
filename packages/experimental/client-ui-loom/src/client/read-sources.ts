/**
 * React-free keyed sources of one-value `loom` Remote reads: the compare of a
 * branch point, the diff of a branch, and a cost estimate. A source reads on
 * its first subscriber and keeps the value while observed; its last
 * unsubscribe drops it, so a later observation reads again. A source can read
 * again on request while it keeps showing its last value, and a request that
 * arrives during a read queues exactly one more. The generated Remote methods
 * take no abort signal, so a read that finishes after its source closed is ignored.
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { keyedSourceRegistry, ObservedSource, type KeyedLifecycle } from './keyed-sources.ts'

/** Read state of one keyed value. */
export type LoomReadState<Value> =
  | { readonly status: 'loading' }
  | {
    readonly status: 'ready'
    readonly value: Value
    /** Whether a later read is in flight; the value shown is the previous one. */
    readonly refreshing: boolean
    /** Whether the latest later read failed, so the value shown may be out of date. */
    readonly stale: boolean
  }
  /** A failed first read; `code` is the typed Remote failure, absent when the call itself could not be made. */
  | { readonly status: 'failed'; readonly code?: string }

/** Keyed read sources owned by one plugin fiber. */
export interface LoomReadSources<Value> {
  /**
   * Return the source of one key; a source dropped by its last unsubscribe is replaced by a fresh one that reads again.
   * @param key - the key the owner's hook binds.
   * @returns the source, stable while observed.
   */
  source(key: string): ObservableSnapshot<LoomReadState<Value>>
  /**
   * Read the value of a key again while its source is observed; nothing happens for a key nobody observes.
   * @param key - the source key.
   */
  refresh(key: string): void
  /** Close every source; reads still in flight change nothing. */
  dispose(): void
}

const LOADING: LoomReadState<never> = Object.freeze({ status: 'loading' })

/**
 * Create the keyed sources of one Remote read.
 * @param read - the Remote call of one key.
 * @param tag - source name for diagnostics.
 * @returns the sources; the caller disposes them with its fiber.
 */
export function createLoomReadSources<Value>(
  read: (key: string) => Promise<RemoteResult<Value>>,
  tag: string,
): LoomReadSources<Value> {
  const registry = keyedSourceRegistry((key, lifecycle) => new ReadSource<Value>(key, read, tag, lifecycle))
  return {
    source: key => registry.get(key),
    refresh(key) { registry.peek(key)?.refresh() },
    dispose() { registry.dispose() },
  }
}

/** One key's read. */
class ReadSource<Value> extends ObservedSource<LoomReadState<Value>> {
  private reading = false
  private queued = false
  /** Changes when the source closes, so a result of an earlier read is recognized and dropped. */
  private epoch = 0
  /** Whether any observer has been present since the source was created or closed. */
  private watched = false

  constructor(
    private readonly key: string,
    private readonly read: (key: string) => Promise<RemoteResult<Value>>,
    tag: string,
    lifecycle: KeyedLifecycle,
  ) {
    super(LOADING, lifecycle, tag)
  }

  refresh(): void {
    if (!this.watched) return
    if (this.reading) this.queued = true
    else this.start()
  }

  protected observed(): void {
    this.watched = true
    // An observer that returns resumes a read that closing dropped. A source whose read ended, with a value or a
    // failure, does not read again: a failed read asks for a retry through `refresh`, and a source nobody
    // observes is replaced by a fresh one.
    const unfinished = this.state.status === 'loading' || (this.state.status === 'ready' && this.state.refreshing)
    if (unfinished && !this.reading) this.start()
  }

  protected released(): void {
    this.watched = false
    this.epoch += 1
    this.reading = false
    this.queued = false
  }

  private start(): void {
    const epoch = this.epoch
    this.reading = true
    this.queued = false
    const previous = this.state
    if (previous.status === 'ready') this.publish({ ...previous, refreshing: true })
    else if (previous.status === 'failed') this.publish(LOADING)
    this.read(this.key).then((result) => { this.settle(epoch, result) }, (_error: unknown) => {
      // A rejected call is an assembly fault (the Remote is not mounted); the reader sees a failed read without a code.
      this.settle(epoch, undefined)
    })
  }

  private settle(epoch: number, result: RemoteResult<Value> | undefined): void {
    if (epoch !== this.epoch) return
    this.reading = false
    const previous = this.state
    if (result?.ok === true) this.publish({ status: 'ready', value: result.value, refreshing: false, stale: false })
    else if (previous.status === 'ready') this.publish({ ...previous, refreshing: false, stale: true })
    else this.publish({ status: 'failed', ...result === undefined ? {} : { code: result.error.code } })
    if (this.queued) this.start()
  }
}
