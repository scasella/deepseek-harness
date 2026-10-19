/** The keyed source registry drops idle sources and still disposes a dropped source that a render observes again. */
import { describe, expect, it, vi } from 'vitest'
import { keyedSourceRegistry, type KeyedLifecycle } from '../src/client/keyed-sources.ts'

/** A source whose observation the test reports through its lifecycle. */
class Probe {
  readonly close = vi.fn()
  constructor(readonly key: string, readonly lifecycle: KeyedLifecycle) {}
}

describe('Loom keyed source registry', () => {
  it('keeps a source while observed and drops it when idle', () => {
    const registry = keyedSourceRegistry((key, lifecycle) => new Probe(key, lifecycle))
    const first = registry.get('k')
    expect(registry.get('k')).toBe(first)
    first.lifecycle.active()
    first.lifecycle.idle()
    const second = registry.get('k')
    expect(second).not.toBe(first)
    registry.dispose()
    expect(second.close).toHaveBeenCalledOnce()
    expect(first.close).not.toHaveBeenCalled()
  })

  it('returns a dropped source that is observed again to its key, unless a fresh source took the key', () => {
    const registry = keyedSourceRegistry((key, lifecycle) => new Probe(key, lifecycle))
    const dropped = registry.get('k')
    dropped.lifecycle.active()
    dropped.lifecycle.idle()
    dropped.lifecycle.active()
    expect(registry.get('k')).toBe(dropped)
    dropped.lifecycle.idle()
    const fresh = registry.get('k')
    dropped.lifecycle.active()
    expect(registry.get('k')).toBe(fresh)
    // The stale source going idle never drops the fresh one.
    dropped.lifecycle.idle()
    expect(registry.get('k')).toBe(fresh)
    dropped.lifecycle.active()
    registry.dispose()
    expect(dropped.close).toHaveBeenCalledOnce()
    expect(fresh.close).toHaveBeenCalledOnce()
    const after = registry.get('k')
    expect(after).not.toBe(fresh)
  })
})
