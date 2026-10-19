/**
 * Keyed source registry shared by the Loom family, reader, and request
 * sources. A source stays in the registry while observed and leaves it when
 * its last observer leaves, so a Session or step the reader stopped viewing
 * keeps nothing alive; the next lookup of that key creates a fresh source.
 */

import { notifySubscribers, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** Observation changes a source reports to the registry that created it. */
export interface KeyedLifecycle {
  /** The source gained its first observer. */
  active(): void
  /** The source lost its last observer and released what it held. */
  idle(): void
}

/** A source the registry can close when its owner is disposed. */
export interface ClosableSource {
  /** Drop every observer and release what the source holds. */
  close(): void
}

/** Keyed sources owned by one plugin fiber. */
export interface KeyedSourceRegistry<S extends ClosableSource> {
  /**
   * Return the current source of a key, creating it when none is registered.
   * @param key - source key.
   * @returns the registered source.
   */
  get(key: string): S
  /**
   * Return the source of a key without creating one.
   * @param key - source key.
   * @returns the registered source, or undefined when none is registered.
   */
  peek(key: string): S | undefined
  /** Close every registered or still observed source. */
  dispose(): void
}

/**
 * Create a registry that drops idle sources.
 * @param create - builds the source of one key; it reports observation through the lifecycle.
 * @returns the registry; the caller disposes it with its fiber.
 */
export function keyedSourceRegistry<S extends ClosableSource>(
  create: (key: string, lifecycle: KeyedLifecycle) => S,
): KeyedSourceRegistry<S> {
  const sources = new Map<string, S>()
  // A source evicted while a render still held it can gain an observer again; it is tracked
  // here so disposal reaches it even when a fresh source has taken its key.
  const observed = new Set<S>()
  return {
    get(key) {
      const existing = sources.get(key)
      if (existing !== undefined) return existing
      const source: S = create(key, {
        active: () => {
          observed.add(source)
          if (!sources.has(key)) sources.set(key, source)
        },
        idle: () => {
          observed.delete(source)
          if (sources.get(key) === source) sources.delete(key)
        },
      })
      sources.set(key, source)
      return source
    },
    peek: key => sources.get(key),
    dispose() {
      for (const source of new Set([...sources.values(), ...observed])) source.close()
      sources.clear()
      observed.clear()
    },
  }
}

/**
 * Base of a source that starts work on its first subscriber and releases it on
 * its last: it holds the listeners, reports observation to its registry, and
 * publishes state to subscribers. The registry drops a source whose last
 * subscriber leaves, so a later observation of its key creates a fresh one.
 */
export abstract class ObservedSource<State> implements ObservableSnapshot<State>, ClosableSource {
  private readonly listeners = new Set<() => void>()

  /**
   * @param state - state shown before the first publication.
   * @param lifecycle - the registry's observation callbacks.
   * @param tag - source name in diagnostics.
   */
  protected constructor(
    protected state: State,
    private readonly lifecycle: KeyedLifecycle,
    private readonly tag: string,
  ) {}

  /** @returns the state last published. */
  getSnapshot(): State { return this.state }

  /**
   * Observe the source; the first observer starts its work.
   * @param listener - called after each publication.
   * @returns the unsubscribe function; the last one releases the source.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      this.lifecycle.active()
      this.observed()
    }
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return
      this.close()
      this.lifecycle.idle()
    }
  }

  /** Drop every observer and release what the source holds. */
  close(): void {
    this.listeners.clear()
    this.released()
  }

  /** The first subscriber arrived; start the source's work. */
  protected abstract observed(): void

  /** The last subscriber left or the owner closed the source; stop the source's work. */
  protected abstract released(): void

  /**
   * Show a new state to every subscriber.
   * @param state - the new state.
   */
  protected publish(state: State): void {
    this.state = state
    notifySubscribers(this.listeners, `[client-ui-loom] ${this.tag}`)
  }
}
