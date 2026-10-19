/** Pure Host presenters of the autoloom tool cards. */
import type { GenericCallView, GenericResultView, ToolResult } from '@deepseek-ai/dsh-tools'

/** `loom_expand` arguments a card reads. */
type ExpandArgs = { readonly sessionId?: string; readonly afterTurn: number; readonly lines?: readonly string[]; readonly count?: number }

/**
 * Short Session label of a title.
 * @param sessionId - the Session, or undefined for the calling Session.
 * @returns the id's first 12 characters, or `this Session`.
 */
function short(sessionId: string | undefined): string {
  if (sessionId === undefined) return 'this Session'
  return sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId
}

/**
 * Count phrase of a branch request.
 * @param args - `loom_expand` arguments.
 * @returns e.g. `2 ways`.
 */
function ways(args: ExpandArgs): string {
  const count = args.lines?.length ?? args.count ?? 0
  return `${String(count)} ${count === 1 ? 'way' : 'ways'}`
}

/**
 * Pending `loom_expand` card.
 * @param args - validated arguments.
 * @returns a card naming the target, the turn, and the prompts.
 */
export function presentExpandCall(args: ExpandArgs): GenericCallView {
  return {
    card: 'generic',
    title: `Branch ${short(args.sessionId)} ${ways(args)} after turn ${String(args.afterTurn)}`,
    kind: 'other',
    ...args.lines === undefined ? {} : { rawInput: args.lines },
  }
}

/**
 * Completed `loom_expand` card.
 * @param args - validated arguments.
 * @param result - final result.
 * @returns a past-tense title, or undefined for a failure, which keeps the pending title and shows the error.
 */
export function presentExpandResult(args: ExpandArgs, result: ToolResult): GenericResultView | undefined {
  if (result.isError) return undefined
  return { card: 'generic', title: `Branched ${short(args.sessionId)} ${ways(args)} after turn ${String(args.afterTurn)}` }
}

/**
 * Pending `loom_wait` card.
 * @param args - validated arguments.
 * @returns a card naming the set.
 */
export function presentWaitCall(args: { readonly setId: string }): GenericCallView {
  return { card: 'generic', title: `Wait for branch set ${args.setId}`, kind: 'other' }
}

/**
 * Pending `loom_read` card.
 * @param args - validated arguments.
 * @returns a read card naming the branch.
 */
export function presentReadCall(args: { readonly sessionId: string }): GenericCallView {
  return { card: 'generic', title: `Read branch ${short(args.sessionId)}`, kind: 'read' }
}

/**
 * Pending `loom_cull` card.
 * @param args - validated arguments.
 * @returns a delete card naming the branch.
 */
export function presentCullCall(args: { readonly sessionId: string }): GenericCallView {
  return { card: 'generic', title: `Stop and archive branch ${short(args.sessionId)}`, kind: 'delete' }
}

/**
 * Completed `loom_cull` card.
 * @param args - validated arguments.
 * @param result - final result.
 * @returns a past-tense title, or undefined for a failure.
 */
export function presentCullResult(args: { readonly sessionId: string }, result: ToolResult): GenericResultView | undefined {
  return result.isError ? undefined : { card: 'generic', title: `Archived branch ${short(args.sessionId)}` }
}

/**
 * Pending `loom_keep` card.
 * @param args - validated arguments.
 * @returns a card naming the branch.
 */
export function presentKeepCall(args: { readonly sessionId: string }): GenericCallView {
  return { card: 'generic', title: `Keep branch ${short(args.sessionId)}`, kind: 'other' }
}

/**
 * Completed `loom_keep` card.
 * @param args - validated arguments.
 * @param result - final result.
 * @returns a past-tense title, or undefined for a failure.
 */
export function presentKeepResult(args: { readonly sessionId: string }, result: ToolResult): GenericResultView | undefined {
  return result.isError ? undefined : { card: 'generic', title: `Kept branch ${short(args.sessionId)}` }
}
