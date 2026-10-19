# Git 工作树

[English](worktrees.md) | 中文

实验性的 [`dsh-experimental-worktree`](../../packages/experimental/worktree/README.zh.md) 服务提供 `ctx.worktrees`。其消费方 [`create_worktree`](../../packages/experimental/tool-worktree/README.zh.md) 创建新的 Git 分支与检出目录，再通过[工作目录服务](working-directory.zh.md)选中它。[Git 工作树可选 bundle](../../packages/experimental/tool-worktree/README.zh.md#use-this-package)通过 GUI 插件管理器一起加载这两个包。它随安装提供，但默认关闭；显式组合也可以挂载这两个包。

## 创建与保留

调用方 Session 的当前目录决定源仓库。创建操作在分配检出目录前，将请求的本地提交、分支或标签固定为具体提交；省略时选择 `HEAD`。每个名称必须对应新分支与未使用的检出路径。操作既不获取缺失对象，也不复制源检出目录中的未跟踪或被忽略文件。已跟踪文件的暂存与未暂存变更只在 `includeUncommitted` 时带入：它固定一个位于 `HEAD` 之上、记录这些变更的新提交，且不改变源检出目录。

默认目标为 `<current checkout root>/.agents/worktrees/<name>`。`repositoryRoot` 是调用方当前检出目录的顶层目录；因此，链接检出目录会在自身内部保存工作树父目录。仅当服务的分配操作创建了配置指定的父目录时，服务才会写入内容为 `*` 加换行符的 `.gitignore`。已有文件与忽略规则保持不变。调用方 Session 的现有沙箱策略必须允许写入目标目录与共享 Git 管理目录。Git 初始化成功后才改变工作目录。

通过 `working_directory({ cd: path })` 离开时，会保留检出目录与分支。`remove()` 只在仓库登记了该分支上的该检出目录时才删除这个链接检出目录及其分支，并先把调用方移出；否则报告为 `missing`；[Loom 服务](loom.zh.md)正是以这种方式只移除它自己创建的检出目录。取消或失败也可能留下部分产物；错误会指出它们的位置。服务销毁时会中止待完成操作并等待它们结束。[包 README](../../packages/experimental/worktree/README.zh.md)拥有配置与 Git 要求。

## 请求与结果

请求选择新名称，以及本地版本或调用方未提交的已跟踪变更二者之一。结果标识创建的检出目录与确切提交；它不会改变 Session 的原始项目或写权限。`WorktreeCheckout` 通过 `path`、`branch` 与 `repositoryRoot` 指明要移除的检出目录，`WorktreeRemoval` 报告 `removed` 或 `missing`。`WorktreeRepository` 是 `locate()` 的结果：持有最近 `.git` 条目的目录，以及该条目是目录还是文件。`WorktreeGitRequest` 与 `WorktreeGitResult` 承载 `git()` 的一条加固 Git 命令及其有界输出，其中 `truncated` 标志报告超出上限的标准输出。

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md)

Source: [`packages/experimental/worktree/src/index.ts`](../../packages/experimental/worktree/src/index.ts)
<!-- END GENERATED cordis-surface -->
