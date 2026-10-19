/**
 * The route list offered by the Loom route pickers: the Host-generation model
 * catalog, read once on first need through the stable `session` Remote when
 * the client mounts it. Without that namespace the pickers stay hidden and the
 * route line names only the inherited route.
 */
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** One selectable route. */
export interface LoomRouteOption {
  readonly selection: ModelSelection
  /** Provider display name. */
  readonly providerName: string
  /** Model display name. */
  readonly modelName: string
  /** Reasoning efforts the model offers, by id and display name; empty for a model without reasoning levels. */
  readonly efforts: readonly { readonly id: string; readonly name: string }[]
}

/** Facts that decide which route the children of a branch cut at the end of one turn inherit. */
export interface InheritedRouteInput {
  /** Turn the children keep. */
  readonly afterTurn: number
  /** The Session's last turn, as far as the Session list or Chat knows it. */
  readonly lastTurn: number | undefined
  /** Route of the Session's next request: a pick no request used yet, else the route last used. */
  readonly next: ModelSelection | null | undefined
  /** Route the last request of `afterTurn` used, when Chat holds that turn. */
  readonly turnRoute: ModelSelection | undefined
}

/**
 * Pick the route the children of a branch cut at the end of one turn inherit.
 * The cut at the Session's last turn also keeps the standalone events after
 * it, so a pick that no request used yet applies; the cut at any earlier turn
 * keeps the route that turn's last request used.
 * @param input - the cut turn, the Session's last turn, and the routes known.
 * @returns the route, or undefined when it is not known here.
 */
export function inheritedRoute(input: InheritedRouteInput): ModelSelection | undefined {
  return input.afterTurn === input.lastTurn ? input.next ?? undefined : input.turnRoute
}

/** Availability of the route list. */
export type LoomRoutesState =
  | { readonly status: 'unavailable' | 'idle' | 'loading' | 'failed' }
  | { readonly status: 'ready'; readonly options: readonly LoomRouteOption[] }

/** Route list owned by the Loom plugin fiber. */
export interface LoomRoutes {
  readonly state: ObservableSnapshot<LoomRoutesState>
  /**
   * Supply the catalog read while the `session` namespace is mounted.
   * @param read - `session.modelCatalog`.
   * @returns the detach, which hides the pickers again.
   */
  attach(read: () => Promise<RemoteResult<ModelCatalog>>): () => void
  /** Read the catalog once, or again after a failed read; nothing happens while detached or loaded. */
  load(): void
}

const UNAVAILABLE: LoomRoutesState = Object.freeze({ status: 'unavailable' })

/**
 * List the routable models of a catalog.
 * @param catalog - the Host catalog.
 * @returns one option per model of a provider with available routes.
 */
function optionsOf(catalog: ModelCatalog): readonly LoomRouteOption[] {
  const routable = new Set(catalog.routableProviders)
  return catalog.groups.filter(group => routable.has(group.id)).flatMap(group => group.models.map(model => ({
    selection: { provider: group.id, model: model.id },
    providerName: group.name,
    modelName: model.name,
    efforts: model.reasoning?.efforts.map(effort => ({ id: effort.id, name: effort.name })) ?? [],
  })))
}

/**
 * Create the route list.
 * @returns the list, unavailable until a reader attaches.
 */
export function createLoomRoutes(): LoomRoutes {
  const store = createSnapshotStore<LoomRoutesState>(UNAVAILABLE)
  let reader: (() => Promise<RemoteResult<ModelCatalog>>) | undefined
  return {
    state: store,
    attach(read) {
      reader = read
      store.set({ status: 'idle' })
      return () => {
        reader = undefined
        store.set(UNAVAILABLE)
      }
    },
    load() {
      const status = store.getSnapshot().status
      const read = reader
      if (read === undefined || (status !== 'idle' && status !== 'failed')) return
      store.set({ status: 'loading' })
      read().then((result) => {
        if (reader !== read) return
        store.set(result.ok ? { status: 'ready', options: optionsOf(result.value) } : { status: 'failed' })
      }, (_error: unknown) => {
        // A rejected call is an assembly fault; the pickers stay hidden and the next open retries.
        if (reader === read) store.set({ status: 'failed' })
      })
    },
  }
}
