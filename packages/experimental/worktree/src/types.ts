/** Public requests and results for creating, inspecting, and removing Git worktrees. */

/** A new checkout from a locally available Git commit, branch, or tag. */
export interface CreateWorktreeRequest {
  /** New branch name, also used as the relative checkout directory; omission generates a name. */
  name?: string
  /** Local revision to resolve before creation; omission selects HEAD. */
  from?: string
  /**
   * Base the checkout on a new commit whose parent is HEAD and whose tree holds the caller's
   * tracked files as they are now, staged and unstaged changes included; untracked and ignored
   * files are not carried. Without such changes the base is HEAD itself. The source checkout's
   * files, index, and refs keep their content. Requires `from` to be omitted.
   */
  includeUncommitted?: boolean
}

/** Committed Git baseline and the calling Session's resulting working directory. */
export interface CreatedWorktree {
  /** Canonical absolute checkout directory in the filesystem provider's execution world. */
  path: string
  /** Newly created branch name. */
  branch: string
  /** Resolved commit object name; repository-local replacement refs can change its checked-out content. */
  baseCommit: string
  /** Canonical root of the source checkout. */
  repositoryRoot: string
}

/** A linked checkout to remove, as {@link CreatedWorktree} reported it. */
export interface WorktreeCheckout {
  /** Canonical absolute checkout directory. */
  path: string
  /** Branch the checkout holds; it is deleted with the checkout. */
  branch: string
  /** Canonical root of the source checkout that registered the checkout. */
  repositoryRoot: string
}

/**
 * Outcome of one removal. `removed`: the checkout directory, its registration, and its branch
 * are gone. `missing`: the repository registers no linked checkout at that path holding that
 * branch, so nothing was changed.
 */
export type WorktreeRemoval = { kind: 'removed' } | { kind: 'missing' }

/**
 * Git repository that contains a directory, found from the nearest `.git` entry at or above it.
 * `directory`: the entry is the repository's own administration directory. `file`: the entry
 * points to administration data elsewhere, as in a linked checkout or a submodule.
 */
export interface WorktreeRepository {
  /** Canonical directory that holds the `.git` entry. */
  root: string
  /** Kind of the `.git` entry. */
  administration: 'directory' | 'file'
}

/** One Git invocation under the calling Session's file policy. */
export interface WorktreeGitRequest {
  /** Canonical working directory of the process. */
  cwd: string
  /** Literal Git arguments after the service's hardening options; never shell-interpreted. */
  args: readonly string[]
  /** Exit codes that count as success; omission accepts 0 only. */
  allowedExitCodes?: readonly number[]
  /** Text written to standard input before it is closed; omission leaves standard input empty. */
  stdin?: string
  /** Disable the clean, smudge, and process filter drivers configured for `cwd`, as checkout creation does. */
  disableFilters?: boolean
  /** Cap in bytes for standard output; omission uses the configured `maxOutputBytes`. */
  maxOutputBytes?: number
}

/** Bounded output of one Git invocation whose exit code was allowed. */
export interface WorktreeGitResult {
  /** Complete standard output; empty when `truncated`. */
  stdout: string
  /** Standard error, its tail when it exceeded the configured `maxOutputBytes`. */
  stderr: string
  exitCode: number
  /** Whether standard output exceeded its cap. */
  truncated: boolean
}
