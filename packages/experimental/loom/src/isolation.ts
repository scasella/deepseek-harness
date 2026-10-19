/**
 * Explicit resolution of a branch request's isolation before any fork, and the
 * per-repository serialization of the Git work that creates, applies, and
 * removes Loom worktrees.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-worktree'
import type {} from '@deepseek-ai/dsh-fs'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { LoomBranchSource, LoomBranchSpec } from './branch-spec.ts'
import type { LoomIsolation, LoomIsolationUnavailableReason } from './types.ts'

/** Repository every child of a worktree set gets its worktree from. */
export interface LoomWorktreeSpec {
  /** Canonical root of the source checkout. */
  readonly repositoryRoot: string
}

/**
 * Failure of an isolation request.
 * @param reason - why worktrees cannot be created.
 * @returns the RemoteError.
 */
function unavailable(reason: LoomIsolationUnavailableReason): RemoteError<'loom/isolation-unavailable'> {
  return new RemoteError('loom/isolation-unavailable', `loom.branch cannot isolate children in worktrees: ${reason}`, { reason })
}

/**
 * Resolve where the children of one set keep their files. A `worktree` set
 * needs the worktree service, a sandbox mode at the cut that can write, and a
 * Git repository containing the source's working directory at the cut. Under
 * a confined mode, that repository's root must also lie inside the source
 * folder and hold its own `.git` directory, because Git writes the new
 * worktree's data there and the sandbox confines writes to the folder.
 * @param ctx - Loom service Context.
 * @param isolation - requested isolation after the configured default.
 * @param source - the Session the children are forked from.
 * @param spec - the resolved branch spec.
 * @returns the repository for a `worktree` set, or undefined for a `shared` set.
 * @throws RemoteError `loom/isolation-unavailable` when worktrees cannot be created.
 */
export async function resolveIsolation(
  ctx: Context,
  isolation: LoomIsolation,
  source: LoomBranchSource,
  spec: LoomBranchSpec,
): Promise<LoomWorktreeSpec | undefined> {
  if (isolation === 'shared') return undefined
  const worktrees = ctx.get('worktrees')
  if (worktrees === undefined) throw unavailable('service-unavailable')
  if (!spec.writable) throw unavailable('read-only')
  const folder = source.meta.cwd
  if (folder === undefined) throw unavailable('no-repository')
  const moved = source.events.slice(0, spec.cut + 1).findLast((event): event is SessionEvent<'working-directory/change'> =>
    event.type === 'working-directory/change')
  const repository = await worktrees.locate(moved?.data.cwd ?? folder)
  if (repository === undefined) throw unavailable('no-repository')
  if (spec.mode !== 'danger-full-access') {
    if (repository.administration === 'file') throw unavailable('linked-checkout')
    const writable = await ctx.fs.resolve(folder)
    if (!ctx.fs.contains(writable, await ctx.fs.resolve(repository.root))) throw unavailable('subdirectory')
  }
  return { repositoryRoot: repository.root }
}

/**
 * Serializes Git work per repository: worktree creation, apply, and removal
 * each take the repository's turn, so concurrent children never contend on one
 * repository's Git locks. Owned by the Loom service for its lifetime.
 */
export class RepositoryQueue {
  private readonly tails = new Map<string, Promise<void>>()

  /**
   * Run one task after every earlier task of the same repository settled.
   * @param repositoryRoot - canonical repository root.
   * @param task - the work.
   * @returns the task's result.
   */
  run<T>(repositoryRoot: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(repositoryRoot) ?? Promise.resolve()
    const result = previous.then(task)
    const tail = result.then(() => {}, () => {})
    this.tails.set(repositoryRoot, tail)
    void tail.then(() => {
      if (this.tails.get(repositoryRoot) === tail) this.tails.delete(repositoryRoot)
    })
    return result
  }
}
