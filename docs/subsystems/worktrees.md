# Git Worktrees

English | [中文](worktrees.zh.md)

The experimental [`dsh-experimental-worktree`](../../packages/experimental/worktree/README.md) service provides `ctx.worktrees`. Its [`create_worktree`](../../packages/experimental/tool-worktree/README.md) consumer creates a new Git branch and checkout, then selects it through the [working-directory service](working-directory.md). The [Git Worktrees optional bundle](../../packages/experimental/tool-worktree/README.md#use-this-package) loads both packages through the GUI plugin manager. It ships switched off; explicit compositions can also mount the two packages.

## Creation and retention

The calling Session's current directory selects the source repository. Creation pins the requested local commit, branch, or tag before allocating the checkout; omission selects `HEAD`. Each name must identify a new branch and an unused checkout path. The operation neither fetches missing objects nor copies untracked or ignored files from the source checkout. Staged and unstaged changes to tracked files are carried only with `includeUncommitted`, which pins a new commit above `HEAD` that records them without changing the source checkout.

The default destination is `<current checkout root>/.agents/worktrees/<name>`. `repositoryRoot` is the top-level directory of the caller’s current checkout; a linked checkout therefore contains its own pool. The service writes a `.gitignore` containing `*` and a trailing newline only when its allocation creates the configured pool directory. Existing files and ignore rules are preserved. The calling Session’s existing sandbox policy must permit writes to the destination and shared Git administration directory. Successful Git setup precedes the working-directory change.

Leaving through `working_directory({ cd: path })` retains the checkout and branch. `remove()` deletes a linked checkout and its branch only when the repository registers that checkout on that branch, moving the caller out first, and otherwise reports it `missing`; the [Loom service](loom.md) removes exactly the checkouts it created this way. Cancellation or failure can also retain partial artifacts; the error identifies their location. The service aborts and drains pending operations on disposal. The [package README](../../packages/experimental/worktree/README.md) owns configuration and Git requirements.

## Request and result

The request selects the new name and either a local revision or the caller's uncommitted tracked changes. The result identifies the created checkout and exact commit; it does not change the Session's original project or write permissions. `WorktreeCheckout` names a checkout to remove by `path`, `branch`, and `repositoryRoot`, and `WorktreeRemoval` reports `removed` or `missing`. `WorktreeRepository` is the result of `locate()`: the directory holding the nearest `.git` entry and whether that entry is a directory or a file. `WorktreeGitRequest` and `WorktreeGitResult` carry one hardened Git command of `git()` and its bounded output, whose `truncated` flag reports standard output beyond the cap.

```ts type-equiv
/** A new checkout from a locally available Git commit, branch, or tag. */
interface CreateWorktreeRequest {
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
```

```ts type-equiv
/** Committed Git baseline and the calling Session's resulting working directory. */
interface CreatedWorktree {
  /** Canonical absolute checkout directory in the filesystem provider's execution world. */
  path: string
  /** Newly created branch name. */
  branch: string
  /** Resolved commit object name; repository-local replacement refs can change its checked-out content. */
  baseCommit: string
  /** Canonical root of the source checkout. */
  repositoryRoot: string
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworktrees--worktreeservice"></a>

### `ctx.worktrees` — `WorktreeService`

Creates, enters, and removes Git worktrees under the mounted filesystem and sandbox providers.

```ts cordis-catalog
/**
 * Create a fresh branch and checkout at a pinned local revision, then enter it.
 * Existing branches or checkout paths fail. Uncommitted files stay in the source checkout;
 * `includeUncommitted` bases the checkout on a new commit that records the tracked ones.
 * Checkout disables configured clean, smudge, and process filters without changing Git config.
 * Repository-local replacement refs still apply; baseCommit reports the resolved object name.
 * The new checkout becomes current only after Git setup succeeds. Failures may retain newly
 * allocated Git/filesystem artifacts; no branch or checkout is removed automatically.
 * @param agent - caller whose current directory selects the source repository and file policy.
 * @param request - optional new name, local revision or uncommitted-change base; defaults are generated name and HEAD.
 * @param signal - cancellation of lookup, creation, and working-directory publication.
 * @returns canonical checkout path, branch name, pinned commit, and source repository root.
 */
async create(agent: Agent, request: CreateWorktreeRequest = {}, signal?: AbortSignal): Promise<CreatedWorktree>

/**
 * Find the Git repository that contains a directory from the nearest `.git` entry at or above
 * it, without running Git and without the caller's file policy.
 * @param directory - absolute directory in the filesystem provider's execution world.
 * @param signal - cancellation of the filesystem reads.
 * @returns the repository root and the kind of its `.git` entry, or undefined when the directory
 *   does not exist or no ancestor has one.
 */
async locate(directory: string, signal?: AbortSignal): Promise<WorktreeRepository | undefined>

/**
 * Remove one linked checkout and delete its branch, discarding the files it holds. The
 * repository must register a linked checkout at `checkout.path` holding `checkout.branch`;
 * otherwise nothing changes. When the caller's current directory is inside the checkout, the
 * caller first moves to `checkout.repositoryRoot`.
 * @param agent - caller whose file policy governs the removal.
 * @param checkout - checkout path, branch, and source repository root as creation reported them.
 * @param signal - cancellation of the lookup, directory change, and removal.
 * @returns `removed`, or `missing` when the repository registers no such checkout.
 * @throws when the branch is not a relative branch name or a Git command fails; a failure after
 *   the checkout's removal can leave its branch.
 */
async remove(agent: Agent, checkout: WorktreeCheckout, signal?: AbortSignal): Promise<WorktreeRemoval>

/**
 * Run one Git command with this service's executable and limits, hooks and the file-system
 * monitor disabled, confined to the caller's file policy. Standard output beyond its cap
 * resolves with `truncated` set.
 * @param agent - caller whose file policy governs the command.
 * @param request - directory, arguments, allowed exit codes, standard input, output cap, and filter choice.
 * @param signal - cancellation of the command.
 * @returns the command's output and exit code.
 * @throws when `maxOutputBytes` is not a positive integer, or the exit code is not allowed.
 */
async git(agent: Agent, request: WorktreeGitRequest, signal?: AbortSignal): Promise<WorktreeGitResult>
```

Types: [Agent](core.md)

Source: [`packages/experimental/worktree/src/index.ts`](../../packages/experimental/worktree/src/index.ts)
<!-- END GENERATED cordis-surface -->
