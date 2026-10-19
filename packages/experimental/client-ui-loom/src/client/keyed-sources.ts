/**
 * Keyed source registry shared by the Loom family, reader, and request
 * sources. A source stays in the registry while observed and leaves it when
 * its last observer leaves, so a Session or step the reader stopped viewing
 * keeps nothing alive; the next lookup of that key creates a fresh source.
 */

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
    dispose() {
      for (const source of new Set([...sources.values(), ...observed])) source.close()
      sources.clear()
      observed.clear()
    },
  }
}
