/**
 * Git reads and writes for a branch child's worktree, through the worktree
 * service's hardened Git command under the child's own file policy: the
 * changed files against the base commit, untracked files included, their
 * unified diff, and the copy of the change into the source checkout.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WorktreeGitResult, WorktreeService } from '@deepseek-ai/dsh-experimental-worktree'
import type { LoomCompareDiffFile, LoomIsolationRecord } from './types.ts'

/** Options of every diff Loom reads: no external diff or text conversion programs, no color, no rename pairing. */
const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'] as const

/** Leading Git options of every read: no optional index writes, and paths taken literally. */
const READ_OPTIONS = ['--no-optional-locks', '--literal-pathspecs'] as const

/** One worktree, the child whose policy governs commands in it, and the service that runs them. */
export interface WorktreeTarget {
  readonly worktrees: WorktreeService
  readonly agent: Agent
  readonly isolation: LoomIsolationRecord
  readonly signal: AbortSignal
}

/** A changed file and whether Git tracks it in the worktree. */
interface ChangedFile extends LoomCompareDiffFile {
  readonly tracked: boolean
}

/**
 * Run one Git command in the worktree.
 * @param target - the worktree.
 * @param args - Git arguments.
 * @param options - allowed exit codes and the output cap.
 * @returns the command's output.
 */
function inWorktree(
  target: WorktreeTarget,
  args: readonly string[],
  options: { readonly allowedExitCodes?: readonly number[]; readonly maxOutputBytes?: number } = {},
): Promise<WorktreeGitResult> {
  return target.worktrees.git(target.agent, { cwd: target.isolation.worktreePath, args, ...options }, target.signal)
}

/**
 * Code-unit order of two strings, independent of locale.
 * @param left - a string.
 * @param right - another string.
 * @returns negative, zero, or positive.
 */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Path order of two changed files.
 * @param left - a file.
 * @param right - another file.
 * @returns negative, zero, or positive.
 */
export function byPath(left: { readonly path: string }, right: { readonly path: string }): number {
  return compareText(left.path, right.path)
}

/**
 * Line counts of one `--numstat` field; Git prints `-` for a binary file.
 * @param value - the count field.
 * @returns the count, 0 for a binary file.
 */
function lines(value: string): number {
  return value === '-' ? 0 : Number(value)
}

/**
 * Every file the worktree changed against its base commit, in path order:
 * tracked files that differ, then untracked files that ignore rules keep, as
 * additions.
 * @param target - the worktree.
 * @returns the changed files.
 */
async function changedFiles(target: WorktreeTarget): Promise<ChangedFile[]> {
  const { baseCommit } = target.isolation
  const numstat = await inWorktree(target, [...READ_OPTIONS, 'diff', '--numstat', '-z', ...DIFF_OPTIONS, baseCommit, '--'])
  const files: ChangedFile[] = []
  for (const record of numstat.stdout.split('\0')) {
    if (record.length === 0) continue
    const [insertions = '', deletions = '', ...path] = record.split('\t')
    files.push({ path: path.join('\t'), insertions: lines(insertions), deletions: lines(deletions), tracked: true })
  }
  const untracked = await inWorktree(target, [...READ_OPTIONS, 'ls-files', '--others', '--exclude-standard', '-z'])
  for (const path of untracked.stdout.split('\0')) {
    if (path.length === 0) continue
    const added = await inWorktree(target, ['diff', '--no-index', '--numstat', '-z', ...DIFF_OPTIONS, '--', '/dev/null', path], { allowedExitCodes: [0, 1] })
    const [insertions = '', deletions = ''] = added.stdout.split('\t')
    files.push({ path, insertions: lines(insertions), deletions: lines(deletions), tracked: false })
  }
  return files.sort(byPath)
}

/**
 * Changed files of a worktree against its base commit, untracked files included.
 * @param target - the worktree.
 * @returns each file's added and deleted lines, in path order.
 */
export async function worktreeChanges(target: WorktreeTarget): Promise<LoomCompareDiffFile[]> {
  return (await changedFiles(target)).map(({ path, insertions, deletions }) => ({ path, insertions, deletions }))
}

/**
 * Diff text of one changed file.
 * @param target - the worktree.
 * @param file - the file.
 * @param extra - further diff options.
 * @param maxOutputBytes - output cap.
 * @returns the command output; `truncated` when the text exceeds the cap.
 */
function fileDiff(target: WorktreeTarget, file: ChangedFile, extra: readonly string[], maxOutputBytes: number): Promise<WorktreeGitResult> {
  return file.tracked
    ? inWorktree(target, [...READ_OPTIONS, 'diff', ...extra, ...DIFF_OPTIONS, target.isolation.baseCommit, '--', file.path], { maxOutputBytes })
    : inWorktree(target, ['diff', '--no-index', ...extra, ...DIFF_OPTIONS, '--', '/dev/null', file.path], { allowedExitCodes: [0, 1], maxOutputBytes })
}

/**
 * Unified diff of a worktree against its base commit, file after file in
 * path order, within a byte budget. A file whose text exceeds what remains of
 * the budget ends the text there.
 * @param target - the worktree.
 * @param path - one changed file, or undefined for every changed file.
 * @param maxBytes - UTF-8 byte budget of the text.
 * @returns the text and whether files were left out.
 */
export async function worktreeUnifiedDiff(
  target: WorktreeTarget,
  path: string | undefined,
  maxBytes: number,
): Promise<{ unified: string; truncated: boolean }> {
  let unified = ''
  let used = 0
  for (const file of await changedFiles(target)) {
    if (path !== undefined && file.path !== path) continue
    // A changed file's diff is never empty, so a spent budget of one byte truncates it.
    const text = await fileDiff(target, file, [], Math.max(1, maxBytes - used))
    if (text.truncated) return { unified, truncated: true }
    unified += text.stdout
    used += Buffer.byteLength(text.stdout)
  }
  return { unified, truncated: false }
}

/** The worktree's whole change as one binary-safe patch for `git apply`. */
export interface WorktreePatch {
  /** Patch text; empty when nothing changed. */
  readonly patch: string
  /** Changed paths in path order. */
  readonly paths: readonly string[]
  /** Whether the patch exceeded its byte cap; `patch` is then incomplete and must not be applied. */
  readonly truncated: boolean
}

/**
 * Binary-safe patch of every change in a worktree against its base commit.
 * @param target - the worktree.
 * @param maxBytes - UTF-8 byte cap of the patch.
 * @returns the patch, its paths, and whether it exceeded the cap.
 */
export async function worktreePatch(target: WorktreeTarget, maxBytes: number): Promise<WorktreePatch> {
  const files = await changedFiles(target)
  let patch = ''
  let used = 0
  for (const file of files) {
    const text = await fileDiff(target, file, ['--binary', '--full-index'], Math.max(1, maxBytes - used))
    if (text.truncated) return { patch: '', paths: [], truncated: true }
    patch += text.stdout
    used += Buffer.byteLength(text.stdout)
  }
  return { patch, paths: files.map(file => file.path), truncated: false }
}

/**
 * Paths with staged or unstaged changes in a checkout, from
 * `git status --porcelain=v1 -z`; a rename or copy contributes its new path.
 * @param output - the command's standard output.
 * @returns the paths in path order.
 */
export function changedTrackedPaths(output: string): string[] {
  const paths: string[] = []
  let original = false
  for (const field of output.split('\0')) {
    // A rename or copy entry is followed by a field holding its original path.
    if (original || field.length < 4) {
      original = false
      continue
    }
    paths.push(field.slice(3))
    original = /^[RC]|^.[RC]/.test(field)
  }
  return paths.sort()
}

/** `git apply` diagnostics that name a path whose change does not apply. */
const CONFLICT_LINES = [
  /^error: patch failed: (.+):\d+$/,
  /^error: (.+): (?:patch does not apply|already exists in working directory|does not exist in index)$/,
  /^error: (.+): (?:does not match index|No such file or directory|wrong type)$/,
]

/**
 * Paths named by `git apply --check` diagnostics.
 * @param stderr - the command's standard error.
 * @returns unique paths in path order; empty when no line names one.
 */
export function conflictPaths(stderr: string): string[] {
  const paths = new Set<string>()
  for (const line of stderr.split('\n')) {
    for (const pattern of CONFLICT_LINES) {
      const path = pattern.exec(line.trimEnd())?.[1]
      if (path !== undefined) paths.add(path)
    }
  }
  return [...paths].sort()
}
