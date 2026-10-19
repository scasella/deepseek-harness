/** Creates Git branches and checkouts, enters them for the calling Session, and removes them on request. */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-working-directory'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { PREPARE_DIRECTORY } from './directory.ts'
import { runCommand } from './process.ts'
import type { CommandOptions, CommandResult, ProcessConfig } from './process.ts'
import type {
  CreatedWorktree,
  CreateWorktreeRequest,
  WorktreeCheckout,
  WorktreeGitRequest,
  WorktreeGitResult,
  WorktreeRemoval,
  WorktreeRepository,
} from './types.ts'

export type * from './types.ts'

/** Worktree location, generated names, executables, and subprocess resource limits. */
export interface Config {
  /** Relative checkout pool inside the source repository. */
  directory?: string
  /** Prefix for automatically generated branch and checkout names. */
  namePrefix?: string
  /** Executable name or absolute execution-world path of a Git release that honors `GIT_NO_LAZY_FETCH`. */
  gitCommand?: string
  /** Node executable used for sandboxed directory allocation. */
  nodeCommand?: string
  /** Deadline in milliseconds for one command. */
  timeoutMs?: number
  /** Subprocess termination grace in milliseconds. */
  graceMs?: number
  /** Maximum captured bytes per subprocess output stream. */
  maxOutputBytes?: number
}

type ResolvedConfig = Required<Config> & ProcessConfig

interface WorktreeSpec {
  branch: string
  revision: string
  includeUncommitted: boolean
}

/** One Git command in a directory under the operation's policy and cancellation. */
type GitRunner = (directory: string, args: readonly string[], options?: CommandOptions) => Promise<CommandResult>

/** Message and fixed identity of the commit that records uncommitted tracked changes. */
const SNAPSHOT_MESSAGE = 'dsh worktree snapshot'
const SNAPSHOT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'dsh worktree',
  GIT_AUTHOR_EMAIL: 'worktree@dsh.invalid',
  GIT_COMMITTER_NAME: 'dsh worktree',
  GIT_COMMITTER_EMAIL: 'worktree@dsh.invalid',
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    worktrees: WorktreeService
  }
}

/** Reject path traversal independently of Git's branch-name grammar. */
function relativePath(value: string): boolean {
  return value.length > 0 && !value.includes('\\') && !value.includes(':')
    && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}

/**
 * Whether `child` is `parent` or a path below it, in either separator convention.
 * @param child - canonical absolute path.
 * @param parent - canonical absolute directory.
 * @returns the containment.
 */
function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`) || child.startsWith(`${parent}\\`)
}

/**
 * Whether `git worktree list --porcelain -z` output registers a linked checkout, not the main
 * checkout it lists first, at a path holding a branch.
 * @param output - the command's standard output, one NUL-terminated field per line and an empty field after each checkout.
 * @param checkout - the path and branch to find.
 * @returns whether a linked checkout matches both.
 */
function registers(output: string, checkout: WorktreeCheckout): boolean {
  return output.split('\0\0').slice(1).some((record) => {
    const fields = record.split('\0')
    return fields.includes(`worktree ${checkout.path}`) && fields.includes(`branch refs/heads/${checkout.branch}`)
  })
}

/** Creates, enters, and removes Git worktrees under the mounted filesystem and sandbox providers. */
export class WorktreeService extends Service {
  static inject = ['workingDirectory', 'fs', 'subprocess', 'sandbox', 'sandboxPolicy']

  static Config: z<Config> = z.object({
    directory: z.string().default('.agents/worktrees'),
    namePrefix: z.string().default('worktree-'),
    gitCommand: z.string().default('git'),
    nodeCommand: z.string().default('node'),
    timeoutMs: z.number().default(60_000),
    graceMs: z.number().default(3_000),
    maxOutputBytes: z.number().default(65_536),
  })

  private readonly config: ResolvedConfig
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'worktrees')
    this.config = config as ResolvedConfig
    if (!relativePath(this.config.directory)) throw new Error('worktree: directory must be a relative directory without dot segments')
    if (!relativePath(`${this.config.namePrefix}name`) || this.config.namePrefix.startsWith('-')) {
      throw new Error('worktree: namePrefix must produce a relative branch name')
    }
    for (const key of ['gitCommand', 'nodeCommand'] as const) {
      if (this.config[key].trim().length === 0) throw new Error(`worktree: ${key} must not be empty`)
    }
    for (const key of ['timeoutMs', 'graceMs', 'maxOutputBytes'] as const) {
      const value = this.config[key]
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
        throw new Error(`worktree: ${key} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
      }
    }
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('worktree service disposed'))
      await Promise.allSettled(this.pending)
    })
  }

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
  async create(agent: Agent, request: CreateWorktreeRequest = {}, signal?: AbortSignal): Promise<CreatedWorktree> {
    return this.track(signal, operationSignal => this.createCheckout(agent, this.resolve(request), operationSignal))
  }

  /**
   * Find the Git repository that contains a directory from the nearest `.git` entry at or above
   * it, without running Git and without the caller's file policy.
   * @param directory - absolute directory in the filesystem provider's execution world.
   * @param signal - cancellation of the filesystem reads.
   * @returns the repository root and the kind of its `.git` entry, or undefined when the directory
   *   does not exist or no ancestor has one.
   */
  async locate(directory: string, signal?: AbortSignal): Promise<WorktreeRepository | undefined> {
    return this.track(signal, async (operationSignal) => {
      const target = await this.ctx.fs.resolve(directory, { signal: operationSignal })
      if ((await this.ctx.fs.stat(target, operationSignal))?.type !== 'directory') return undefined
      let current = this.ctx.fs.processPath(target)
      for (;;) {
        const entry = await this.ctx.fs.lstat('.git', { cwd: current }, operationSignal)
        if (entry !== undefined && (entry.type === 'directory' || entry.type === 'file')) return { root: current, administration: entry.type }
        const parent = this.ctx.fs.processPath(await this.ctx.fs.resolve('..', { cwd: current, signal: operationSignal }))
        if (parent === current) return undefined
        current = parent
      }
    })
  }

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
  async remove(agent: Agent, checkout: WorktreeCheckout, signal?: AbortSignal): Promise<WorktreeRemoval> {
    if (!relativePath(checkout.branch) || checkout.branch.startsWith('-')) throw new Error('worktree branch must be a relative Git branch name')
    return this.track(signal, async (operationSignal) => {
      const run = this.runner(this.ctx.sandboxPolicy.resolve({ session: agent.session }), operationSignal)
      const listed = await run(checkout.repositoryRoot, ['worktree', 'list', '--porcelain', '-z'])
      if (!registers(listed.stdout, checkout)) return { kind: 'missing' }
      if (within(this.ctx.workingDirectory.get(agent.session), checkout.path)) {
        await this.ctx.workingDirectory.set(agent, checkout.repositoryRoot, operationSignal)
      }
      await run(checkout.repositoryRoot, ['worktree', 'remove', '--force', '--', checkout.path])
      await run(checkout.repositoryRoot, ['branch', '-D', '--', checkout.branch])
      return { kind: 'removed' }
    })
  }

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
  async git(agent: Agent, request: WorktreeGitRequest, signal?: AbortSignal): Promise<WorktreeGitResult> {
    const { maxOutputBytes = this.config.maxOutputBytes } = request
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new Error('worktree git maxOutputBytes must be a positive integer')
    return this.track(signal, async (operationSignal) => {
      const run = this.runner(this.ctx.sandboxPolicy.resolve({ session: agent.session }), operationSignal)
      const env = request.disableFilters === true ? await this.filterOverrides(run, request.cwd) : {}
      return run(request.cwd, request.args, {
        ...request.allowedExitCodes === undefined ? {} : { allowedExitCodes: request.allowedExitCodes },
        ...request.stdin === undefined ? {} : { stdin: request.stdin },
        env,
        maxOutputBytes,
        overflow: 'report',
      })
    })
  }

  /**
   * Run one operation under the service lifetime and the caller's cancellation, and keep it
   * pending until it settles so that disposal can await it.
   * @param signal - caller cancellation.
   * @param operation - the operation, given the combined signal.
   * @returns the operation's result.
   */
  private async track<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const operationSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, signal])
    operationSignal.throwIfAborted()
    const pending = operation(operationSignal)
    this.pending.add(pending)
    try {
      return await pending
    } finally {
      this.pending.delete(pending)
    }
  }

  private runner(policy: SandboxExecutionPolicy, signal: AbortSignal): GitRunner {
    return (directory, args, options) => runCommand(
      this.ctx, this.config, policy, directory,
      [this.config.gitCommand, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      signal, options,
    )
  }

  private resolve(request: CreateWorktreeRequest): WorktreeSpec {
    const branch = request.name ?? `${this.config.namePrefix}${randomUUID()}`
    if (!relativePath(branch) || branch.startsWith('-')) throw new Error('worktree name must be a relative Git branch name')
    const includeUncommitted = request.includeUncommitted === true
    if (includeUncommitted && request.from !== undefined) throw new Error('worktree includeUncommitted requires from to be omitted')
    const revision = request.from ?? 'HEAD'
    if (revision.length === 0) throw new Error('worktree from must name a local commit, branch, or tag')
    return { branch, revision, includeUncommitted }
  }

  /**
   * Environment that empties every clean, smudge, and process command and clears `required` for
   * the filter drivers configured in a directory, without changing Git config.
   * @param run - Git runner of the operation.
   * @param directory - directory whose configuration names the drivers.
   * @returns `GIT_CONFIG_*` overrides.
   */
  private async filterOverrides(run: GitRunner, directory: string): Promise<NodeJS.ProcessEnv> {
    const configured = await run(directory, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], { allowedExitCodes: [0, 1] })
    const drivers = new Set<string>()
    for (const key of configured.stdout.split('\0')) {
      const separator = key.lastIndexOf('.')
      if (separator > 'filter.'.length && ['clean', 'smudge', 'process', 'required'].includes(key.slice(separator + 1))) {
        drivers.add(key.slice('filter.'.length, separator))
      }
    }
    const overrides: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(drivers.size * 4) }
    let index = 0
    for (const driver of drivers) {
      for (const attribute of ['clean', 'smudge', 'process', 'required']) {
        overrides[`GIT_CONFIG_KEY_${index}`] = `filter.${driver}.${attribute}`
        overrides[`GIT_CONFIG_VALUE_${index}`] = attribute === 'required' ? 'false' : ''
        index++
      }
    }
    return overrides
  }

  /**
   * Record HEAD plus the tracked files' staged and unstaged changes as a commit whose only parent
   * is HEAD, with filters disabled; HEAD itself when the tracked files match it.
   * @param run - Git runner of the operation.
   * @param repositoryRoot - root of the source checkout.
   * @returns the base commit.
   */
  private async snapshotCommit(run: GitRunner, repositoryRoot: string): Promise<string> {
    const head = (await run(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'])).stdout.trim()
    const env = { ...await this.filterOverrides(run, repositoryRoot), ...SNAPSHOT_IDENTITY }
    const stash = (await run(repositoryRoot, ['stash', 'create', SNAPSHOT_MESSAGE], { env })).stdout.trim()
    if (stash.length === 0) return head
    const treeOf = async (commit: string): Promise<string> =>
      (await run(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `${commit}^{tree}`])).stdout.trim()
    const tree = await treeOf(stash)
    if (tree === await treeOf(head)) return head
    return (await run(repositoryRoot, ['commit-tree', '-p', head, '-m', SNAPSHOT_MESSAGE, tree], { env: SNAPSHOT_IDENTITY })).stdout.trim()
  }

  private async createCheckout(
    agent: Agent,
    { branch, revision, includeUncommitted }: WorktreeSpec,
    signal: AbortSignal,
  ): Promise<CreatedWorktree> {
    const cwd = await this.ctx.workingDirectory.ensure(agent, signal)
    const policy = this.ctx.sandboxPolicy.resolve({ session: agent.session })
    const run = this.runner(policy, signal)
    await run(cwd, ['check-ref-format', `refs/heads/${branch}`])
    const rootOutput = await run(cwd, ['rev-parse', '--show-toplevel'])
    const rootTarget = await this.ctx.fs.resolve(rootOutput.stdout.replace(/\r?\n$/, ''), { cwd, signal })
    const repositoryRoot = this.ctx.fs.processPath(rootTarget)
    const baseCommit = includeUncommitted
      ? await this.snapshotCommit(run, repositoryRoot)
      : (await run(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])).stdout.trim()
    const existing = await run(repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowedExitCodes: [0, 1] })
    if (existing.exitCode === 0) throw new Error(`worktree branch already exists: ${branch}`)
    const pool = await this.ctx.fs.resolve(this.config.directory, { cwd: repositoryRoot, signal })
    const poolPath = this.ctx.fs.processPath(pool)
    const destination = await this.ctx.fs.resolve(branch, { cwd: poolPath, signal })
    const path = this.ctx.fs.processPath(destination)
    if (await this.ctx.fs.lstat(path, undefined, signal) !== undefined) throw new Error(`worktree path already exists: ${path}`)
    try {
      await runCommand(this.ctx, this.config, policy, repositoryRoot,
        [this.config.nodeCommand, '--input-type=module', '-e', PREPARE_DIRECTORY, poolPath, path], signal)
      await run(repositoryRoot, ['--work-tree', repositoryRoot, 'worktree', 'add', '--no-checkout', '-b', branch, '--', path, baseCommit])
      const overrides = await this.filterOverrides(run, path)
      await run(path, ['--work-tree', path, 'reset', '--hard', '--no-recurse-submodules', baseCommit], { env: overrides })
      const canonicalPath = await this.ctx.workingDirectory.set(agent, path, signal)
      return { path: canonicalPath, branch, baseCommit, repositoryRoot }
    } catch (error) {
      throw new Error(`Could not finish worktree ${branch} at ${path}. Any created checkout and branch are retained. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }
}

export default WorktreeService
