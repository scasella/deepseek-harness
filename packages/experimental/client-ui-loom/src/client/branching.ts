/**
 * React-free Loom branching state of one plugin fiber, shared by the turn-tail
 * actions, the input-dock form and running strip, the user-message editor,
 * and the Loom tab: the branch sets this browser started or found running,
 * the open Branch ×N forms, and private marks being saved. A started set runs
 * on the Host without the browser, so disposal drops this state and ignores
 * the results of calls still in flight but never cancels a set.
 */
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {
  LoomBranchChild, LoomBranchKind, LoomBranchRequest, LoomBranchRequestId, LoomBranchValue, LoomCancelRequest,
  LoomCancelValue, LoomIsolation, LoomIsolationUnavailableReason, LoomMark, LoomMarkRequest, LoomMarkValue, LoomSetId,
  LoomSetStatus, LoomSetStatusChild, LoomSetStatusRequest,
} from '@deepseek-ai/dsh-experimental-loom/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteErrorDetailsMap, RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

/** A `loom.branch` request before the browser mints its retry identity. */
export type LoomBranchDraft = LoomBranchRequest extends infer Request
  ? Request extends LoomBranchRequest ? Omit<Request, 'requestId'> : never
  : never

/** Code of a call that never reached the Host because the `loom` namespace is not mounted. */
export const LOOM_UNAVAILABLE = 'loom/unavailable'

/** A refused or failed Loom call, reduced to the facts its copy names. */
export interface LoomFailure {
  /** RemoteError code, or {@link LOOM_UNAVAILABLE}. */
  readonly code: string
  /** `loom/too-many-branches`: the configured limit. */
  readonly limit?: number
  /** `loom/empty-line`: zero-based position of the empty line. */
  readonly line?: number
  /** `loom/turn-unavailable`: why the turn cannot be branched. */
  readonly reason?: RemoteErrorDetailsMap['loom/turn-unavailable']['reason']
  /** `loom/isolation-unavailable`: why worktree isolation cannot run. */
  readonly isolationReason?: LoomIsolationUnavailableReason
  /** `loom/worktree-unavailable`: why the branch has no worktree. */
  readonly worktreeReason?: RemoteErrorDetailsMap['loom/worktree-unavailable']['reason']
  /** `loom/apply-dirty` and `loom/apply-conflict`: the paths in the way; `loom/worktree-cleanup-failed`: the paths the change wrote. */
  readonly paths?: readonly string[]
  /** `loom/adopt-incomplete`: how many siblings stayed unarchived. */
  readonly remaining?: number
  /** Whether the Host may have acted before the failure: a carrier failure leaves the outcome unknown. */
  readonly unknownOutcome: boolean
}

/** Result of one branching verb. */
export type LoomOutcome = { readonly ok: true } | { readonly ok: false; readonly failure: LoomFailure }

/** Lifecycle of one child as this browser knows it; `cancelled` children were withdrawn before they had a Session. */
export type LoomTrackedChildState = 'started' | 'queued' | 'failed' | 'cancelled'

/** One child of a tracked branch set. */
export interface LoomTrackedChild {
  /** Zero-based request index, equal to the child's `loomBranch.index`. */
  readonly index: number
  readonly state: LoomTrackedChildState
  /** Child Session, once one exists; a failed child names it when the failure came after the fork. */
  readonly sessionId?: SessionId
  /** RemoteError code of a failed child. */
  readonly code?: string
}

/** A branch set the running strip follows. */
export interface LoomTrackedSet {
  readonly setId: LoomSetId
  /** Session the set branched from. */
  readonly sourceSessionId: SessionId
  /** Session whose dock or Chat started the set; the strip of both Sessions shows it. */
  readonly ownerSessionId: SessionId
  /** How the set derived its children; absent for a set found running whose status has not been read. */
  readonly kind?: LoomBranchKind
  /** Prompt line of each child by index, for steer and variants sets; empty otherwise. */
  readonly lines: readonly string[]
  /** Children by index, as the latest call or status read reported them. */
  readonly children: readonly LoomTrackedChild[]
  /** Whether the Host no longer holds the set, so its queued children never start. */
  readonly lost: boolean
  /** Status reads that returned the set's children, counted so the strip can schedule the next read after each one. */
  readonly reads: number
}

/** Draft of one Branch ×N form, kept per Session whose input dock shows it. */
export interface LoomBranchForm {
  /** Session the branches fork from. */
  readonly sourceSessionId: SessionId
  /** Last turn every branch keeps. */
  readonly afterTurn: number
  /** One steering line per branch, as typed. */
  readonly rows: readonly string[]
  /** Children per line; above 1 the request is a prompt-variant set. */
  readonly samples: number
  /** Route override for every branch; null keeps the source's route. */
  readonly selection: ModelSelection | null
  /** Where each branch's files live. */
  readonly isolation: LoomIsolation
  /** Why the Host refused worktree isolation for this form, until the form closes; null while untried. */
  readonly isolationUnavailable: LoomIsolationUnavailableReason | null
  /** Whether the form's request is in flight. */
  readonly starting: boolean
  /** Failure of the latest start, until the draft changes. */
  readonly failure: LoomFailure | null
}

/** A mark this browser is saving, saved but not yet read back, or failed to save. */
export type LoomMarkOverride =
  | { readonly status: 'saving' | 'saved'; readonly mark: LoomMark | null }
  | { readonly status: 'failed'; readonly failure: LoomFailure }

/** Branching state of one plugin fiber. */
export interface LoomBranchingState {
  /** Followed sets, one entry per set id. */
  readonly sets: readonly LoomTrackedSet[]
  readonly forms: Readonly<Record<SessionId, LoomBranchForm>>
  readonly marks: Readonly<Record<SessionId, LoomMarkOverride>>
}

/** Fields of a form the user edits. */
export type LoomFormEdit = Partial<Pick<LoomBranchForm, 'rows' | 'samples' | 'selection' | 'isolation'>>

/** Remote calls and navigation supplied by the owning plugin. */
export interface LoomBranchingInputs {
  /** `loom.branch`. */
  readonly branch: (request: LoomBranchRequest) => Promise<RemoteResult<LoomBranchValue>>
  /** `loom.cancel`. */
  readonly cancel: (request: LoomCancelRequest) => Promise<RemoteResult<LoomCancelValue>>
  /** `loom.setStatus`. */
  readonly setStatus: (request: LoomSetStatusRequest) => Promise<RemoteResult<LoomSetStatus>>
  /** `loom.mark`. */
  readonly mark: (request: LoomMarkRequest) => Promise<RemoteResult<LoomMarkValue>>
  /** Read a Session's projections again, so a saved mark reaches the list. */
  readonly refreshProjection: (sessionId: SessionId) => Promise<void>
  /** Open a Session in the main view. */
  readonly openSession: (sessionId: SessionId) => void
}

/** Branching verbs and their state. */
export interface LoomBranching {
  /** Current state; every verb publishes through it. */
  readonly state: ObservableSnapshot<LoomBranchingState>
  /**
   * Start a branch set. A retry of the same draft after a carrier failure
   * reuses the failed call's request id, so the Host creates nothing twice.
   * The result replaces an entry the strip adopted for the same set while the
   * call was in flight.
   * @param draft - the request without its id.
   * @param options.ownerSessionId - Session whose strip follows the set besides its source.
   * @param options.openStarted - open the first child when it started at once.
   * @returns the outcome.
   */
  start(draft: LoomBranchDraft, options: { readonly ownerSessionId: SessionId; readonly openStarted?: boolean }): Promise<LoomOutcome>
  /**
   * Withdraw queued children of a set. When the Host withdrew fewer children
   * than this browser holds as queued among those named, they left the queue
   * meanwhile, so the set's status is read again.
   * @param setId - the set.
   * @param indices - children to withdraw; omission withdraws every queued child.
   * @returns the outcome.
   */
  cancel(setId: LoomSetId, indices?: readonly number[]): Promise<LoomOutcome>
  /**
   * Follow a set this browser did not start, such as one found running after a reload, and read its status.
   * @param set - source, owner, and id of the set.
   */
  adopt(set: { readonly setId: LoomSetId; readonly sourceSessionId: SessionId; readonly ownerSessionId: SessionId }): void
  /**
   * Read a followed set's status again; reads of one set never overlap.
   * @param setId - the set.
   */
  refresh(setId: LoomSetId): void
  /**
   * Stop following a set.
   * @param setId - the set.
   */
  dismiss(setId: LoomSetId): void
  /**
   * Save a Session's private mark.
   * @param sessionId - marked Session.
   * @param mark - new mark, or null to clear it.
   * @returns the outcome.
   */
  setMark(sessionId: SessionId, mark: LoomMark | null): Promise<LoomOutcome>
  /**
   * Open the Branch ×N form in a Session's input dock; an open form for the same source and turn keeps its draft.
   * @param ownerSessionId - Session whose dock shows the form.
   * @param target.sourceSessionId - Session the branches fork from.
   * @param target.afterTurn - last turn every branch keeps.
   */
  openForm(ownerSessionId: SessionId, target: { readonly sourceSessionId: SessionId; readonly afterTurn: number }): void
  /**
   * Change a form's draft and clear its failure.
   * @param ownerSessionId - Session whose dock shows the form.
   * @param edit - changed fields.
   */
  editForm(ownerSessionId: SessionId, edit: LoomFormEdit): void
  /**
   * Close a form and drop its draft.
   * @param ownerSessionId - Session whose dock shows the form.
   */
  closeForm(ownerSessionId: SessionId): void
  /**
   * Start the form's branches: a steer set, or a prompt-variant set when it samples each line more than once.
   * The form closes on success and keeps its draft with the failure otherwise; a form with an empty line starts nothing.
   * @param ownerSessionId - Session whose dock shows the form.
   * @returns true when the branches started and the form closed; false when nothing started or the form changed meanwhile.
   */
  submitForm(ownerSessionId: SessionId): Promise<boolean>
  /** Stop publishing: results that arrive later change nothing, and later verbs start no reads. */
  dispose(): void
}

const EMPTY: LoomBranchingState = Object.freeze({ sets: [], forms: {}, marks: {} })

/** Rows a newly opened form offers. */
const NEW_FORM_ROWS = Object.freeze(['', ''])

/**
 * Reduce a typed Remote failure to the facts the Loom copy names.
 * @param error - the failure.
 * @returns the failure facts.
 */
export function failureOf(error: RemoteFailure): LoomFailure {
  switch (error.code) {
    case 'loom/too-many-branches': return { code: error.code, limit: error.details.limit, unknownOutcome: false }
    case 'loom/empty-line': return { code: error.code, line: error.details.index, unknownOutcome: false }
    case 'loom/turn-unavailable': return { code: error.code, reason: error.details.reason, unknownOutcome: false }
    case 'loom/isolation-unavailable': return { code: error.code, isolationReason: error.details.reason, unknownOutcome: false }
    case 'loom/apply-dirty':
    case 'loom/apply-conflict':
      return { code: error.code, paths: error.details.paths, unknownOutcome: false }
    case 'loom/apply-too-large': return { code: error.code, limit: error.details.limit, unknownOutcome: false }
    case 'loom/worktree-unavailable': return { code: error.code, worktreeReason: error.details.reason, unknownOutcome: false }
    case 'loom/worktree-cleanup-failed': return { code: error.code, paths: error.details.applied, unknownOutcome: false }
    case 'loom/adopt-incomplete': return { code: error.code, remaining: error.details.remaining.length, unknownOutcome: false }
    // A carrier failure or cancellation may arrive after the Host acted.
    case 'gateway/internal':
    case 'gateway/cancelled':
      return { code: error.code, unknownOutcome: true }
    // Every other code, including codes other plugins merge, is a refusal before any effect.
    default: return { code: error.code, unknownOutcome: false }
  }
}

const UNAVAILABLE: LoomFailure = Object.freeze({ code: LOOM_UNAVAILABLE, unknownOutcome: false })

/**
 * Reduce a call that rejected, which happens only when the namespace is not mounted.
 * @param _error - the rejection.
 * @returns the unavailable failure.
 */
function rejected(_error: unknown): { readonly ok: false; readonly failure: LoomFailure } {
  return { ok: false, failure: UNAVAILABLE }
}

/** Result of one Remote call with its failure reduced to copy facts. */
export type LoomValueOutcome<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly failure: LoomFailure }

/**
 * Reduce one Remote call to a value or the facts of its failure.
 * @param call - the pending call.
 * @returns the value, or the failure; a call that rejected reads as {@link LOOM_UNAVAILABLE}.
 */
export function settled<Value>(call: Promise<RemoteResult<Value>>): Promise<LoomValueOutcome<Value>> {
  return call.then((result): LoomValueOutcome<Value> => {
    if (result.ok) return { ok: true, value: result.value }
    return { ok: false, failure: failureOf(result.error) }
  }, rejected)
}

/**
 * Normalize a child from `loom.branch` or `loom.setStatus`.
 * @param child - reported child.
 * @returns the tracked child.
 */
function trackedChild(child: LoomBranchChild | LoomSetStatusChild): LoomTrackedChild {
  const sessionId = 'sessionId' in child ? child.sessionId : undefined
  const code = child.state === 'failed' ? child.code : undefined
  return {
    index: child.index,
    state: child.state,
    ...sessionId === undefined ? {} : { sessionId },
    ...code === undefined ? {} : { code },
  }
}

/**
 * Name each child's prompt line by index.
 * @param draft - the started request.
 * @returns the lines, empty for regenerate and edit sets.
 */
function linesOf(draft: LoomBranchDraft): readonly string[] {
  switch (draft.kind) {
    case 'steer': return draft.lines
    case 'variants': return draft.lines.flatMap(line => Array.from({ length: draft.samples }, () => line))
    case 'regenerate':
    case 'edit':
      return []
  }
}

/**
 * Create the branching state of one plugin fiber.
 * @param inputs - Remote calls, projection refresh, and navigation.
 * @returns the verbs; the caller disposes them with its fiber.
 */
export function createLoomBranching(inputs: LoomBranchingInputs): LoomBranching {
  const store = createSnapshotStore<LoomBranchingState>(EMPTY)
  // Request ids of drafts whose last call ended with an unknown outcome, keyed by the draft's JSON.
  const retryIds = new Map<string, LoomBranchRequestId>()
  // Sets with a status read in flight, and whether another read was asked for meanwhile.
  const reading = new Map<LoomSetId, boolean>()
  let disposed = false

  const update = (next: (state: LoomBranchingState) => LoomBranchingState): void => {
    if (!disposed) store.set(next(store.getSnapshot()))
  }
  const updateSet = (setId: LoomSetId, next: (set: LoomTrackedSet) => LoomTrackedSet): void => {
    update(state => ({ ...state, sets: state.sets.map(set => set.setId === setId ? next(set) : set) }))
  }
  const updateForm = (owner: SessionId, next: (form: LoomBranchForm) => LoomBranchForm): void => {
    update((state) => {
      const form = state.forms[owner]
      return form === undefined ? state : { ...state, forms: { ...state.forms, [owner]: next(form) } }
    })
  }
  const withoutKey = <T>(record: Readonly<Record<SessionId, T>>, key: SessionId): Readonly<Record<SessionId, T>> => {
    const { [key]: _dropped, ...rest } = record
    return rest
  }

  const read = (setId: LoomSetId): void => {
    if (disposed) return
    if (reading.has(setId)) {
      reading.set(setId, true)
      return
    }
    reading.set(setId, false)
    void inputs.setStatus({ setId }).then((result) => {
      if (result.ok) updateSet(setId, set => ({ ...set, children: result.value.children.map(trackedChild), reads: set.reads + 1 }))
      // A Host restart drops the set; a passing read failure keeps the last known children.
      else if (result.error.code === 'loom/set-not-found') updateSet(setId, set => ({ ...set, lost: true }))
    }, (_error: unknown) => {
      // An unmounted namespace leaves the last known children; the strip stays as it was.
    }).finally(() => {
      const again = reading.get(setId) === true
      reading.delete(setId)
      if (again) read(setId)
    })
  }

  const start: LoomBranching['start'] = async (draft, options) => {
    const key = JSON.stringify(draft)
    const requestId = retryIds.get(key) ?? brandString<LoomBranchRequestId>(randomUUID())
    const outcome = await inputs.branch({ ...draft, requestId }).then((result) => {
      if (!result.ok) return { ok: false as const, failure: failureOf(result.error) }
      return { ok: true as const, value: result.value }
    }, rejected)
    if (!outcome.ok) {
      if (outcome.failure.unknownOutcome) retryIds.set(key, requestId)
      else retryIds.delete(key)
      return outcome
    }
    retryIds.delete(key)
    const { setId } = outcome.value
    const children = outcome.value.children.map(trackedChild)
    update((state) => {
      // The family can list the first child before this call returns, so the strip may already follow the set.
      const adopted = state.sets.find(set => set.setId === setId)
      const started: LoomTrackedSet = {
        setId,
        sourceSessionId: draft.sessionId,
        ownerSessionId: options.ownerSessionId,
        kind: draft.kind,
        lines: linesOf(draft),
        children,
        lost: false,
        reads: adopted?.reads ?? 0,
      }
      return {
        ...state,
        sets: adopted === undefined ? [...state.sets, started] : state.sets.map(set => set === adopted ? started : set),
      }
    })
    const first = children[0]
    if (!disposed && options.openStarted === true && first?.state === 'started' && first.sessionId !== undefined) {
      inputs.openSession(first.sessionId)
    }
    return { ok: true }
  }

  return {
    state: store,
    start,
    async cancel(setId, indices) {
      const outcome = await inputs.cancel({ setId, ...indices === undefined ? {} : { indices } }).then((result) => {
        if (result.ok) return { ok: true as const, cancelled: new Set(result.value.cancelled) }
        return { ok: false as const, failure: failureOf(result.error) }
      }, rejected)
      if (!outcome.ok) {
        if (outcome.failure.code === 'loom/set-not-found') updateSet(setId, set => ({ ...set, lost: true }))
        return outcome
      }
      const named = (index: number): boolean => indices === undefined || indices.includes(index)
      // A named child this browser holds as queued that the Host did not withdraw is being forked, started, or failed.
      const moved = store.getSnapshot().sets.find(set => set.setId === setId)?.children
        .some(child => child.state === 'queued' && named(child.index) && !outcome.cancelled.has(child.index)) === true
      updateSet(setId, set => ({
        ...set,
        children: set.children.map(child => outcome.cancelled.has(child.index) ? { ...child, state: 'cancelled' } : child),
      }))
      if (moved) read(setId)
      return { ok: true }
    },
    adopt({ setId, sourceSessionId, ownerSessionId }) {
      if (store.getSnapshot().sets.some(set => set.setId === setId)) return
      update(state => ({
        ...state,
        sets: [...state.sets, { setId, sourceSessionId, ownerSessionId, lines: [], children: [], lost: false, reads: 0 }],
      }))
      read(setId)
    },
    refresh(setId) {
      if (store.getSnapshot().sets.some(set => set.setId === setId)) read(setId)
    },
    dismiss(setId) {
      update(state => ({ ...state, sets: state.sets.filter(set => set.setId !== setId) }))
    },
    async setMark(sessionId, mark) {
      const saving: LoomMarkOverride = { status: 'saving', mark }
      update(state => ({ ...state, marks: { ...state.marks, [sessionId]: saving } }))
      const outcome = await inputs.mark({ sessionId, mark }).then((result) => {
        if (result.ok) return { ok: true as const, mark: result.value.mark }
        return { ok: false as const, failure: failureOf(result.error) }
      }, rejected)
      if (store.getSnapshot().marks[sessionId] !== saving) return outcome.ok ? { ok: true } : outcome
      if (!outcome.ok) {
        update(state => ({ ...state, marks: { ...state.marks, [sessionId]: { status: 'failed', failure: outcome.failure } } }))
        return outcome
      }
      const saved: LoomMarkOverride = { status: 'saved', mark: outcome.mark }
      update(state => ({ ...state, marks: { ...state.marks, [sessionId]: saved } }))
      // The list holds the saved mark once the projections are read again; until then the saved value shows.
      const settle = (): void => {
        if (store.getSnapshot().marks[sessionId] === saved) update(state => ({ ...state, marks: withoutKey(state.marks, sessionId) }))
      }
      inputs.refreshProjection(sessionId).then(settle, (_error: unknown) => {
        // A failed read is recorded on the Session's projection snapshot; the projection catches up on its next frame.
        settle()
      })
      return { ok: true }
    },
    openForm(ownerSessionId, target) {
      update((state) => {
        const open = state.forms[ownerSessionId]
        if (open?.sourceSessionId === target.sourceSessionId && open.afterTurn === target.afterTurn) return state
        const form: LoomBranchForm = {
          ...target,
          rows: NEW_FORM_ROWS,
          samples: 1,
          selection: null,
          isolation: 'shared',
          isolationUnavailable: null,
          starting: false,
          failure: null,
        }
        return { ...state, forms: { ...state.forms, [ownerSessionId]: form } }
      })
    },
    editForm(ownerSessionId, edit) {
      updateForm(ownerSessionId, form => ({ ...form, ...edit, failure: null }))
    },
    closeForm(ownerSessionId) {
      update(state => ({ ...state, forms: withoutKey(state.forms, ownerSessionId) }))
    },
    async submitForm(ownerSessionId) {
      const form = store.getSnapshot().forms[ownerSessionId]
      if (form === undefined || form.starting || form.rows.some(row => row.trim() === '')) return false
      const lines = form.rows.map(row => row.trim())
      const base = {
        sessionId: form.sourceSessionId,
        afterTurn: form.afterTurn,
        lines,
        isolation: form.isolation,
        ...form.selection === null ? {} : { selection: form.selection },
      }
      const draft: LoomBranchDraft = form.samples > 1
        ? { ...base, kind: 'variants', samples: form.samples }
        : { ...base, kind: 'steer' }
      updateForm(ownerSessionId, current => ({ ...current, starting: true, failure: null }))
      const outcome = await start(draft, { ownerSessionId })
      if (store.getSnapshot().forms[ownerSessionId]?.afterTurn !== form.afterTurn) return false
      if (!outcome.ok) {
        // A refused isolation is a fact of this Session's folder, so the form falls back to the shared folder and keeps the reason.
        const refused = outcome.failure.isolationReason
        updateForm(ownerSessionId, current => ({
          ...current,
          starting: false,
          failure: outcome.failure,
          ...refused === undefined ? {} : { isolation: 'shared' as const, isolationUnavailable: refused },
        }))
        return false
      }
      update(state => ({ ...state, forms: withoutKey(state.forms, ownerSessionId) }))
      return true
    },
    dispose() {
      disposed = true
      retryIds.clear()
      reading.clear()
    },
  }
}
