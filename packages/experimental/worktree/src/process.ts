/** Bounded, cancellable commands under the calling Session's existing file policy. */

import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessCollectedOutputs } from '@deepseek-ai/dsh-subprocess'
import { deadline } from '@deepseek-ai/dsh-timeout'

/** Resolved process resource limits owned by the worktree service. */
export interface ProcessConfig {
  /** Deadline for one command, including executable lookup and confinement. */
  timeoutMs: number
  /** Termination grace period for each managed subprocess. */
  graceMs: number
  /** Maximum captured bytes per output stream. */
  maxOutputBytes: number
}

/** Per-command choices beyond the argv. */
export interface CommandOptions {
  /** Command-specific successful statuses; omission accepts 0 only. */
  allowedExitCodes?: readonly number[]
  /** Command-local environment overrides, applied after Git selector removal. */
  env?: NodeJS.ProcessEnv
  /** Text written to standard input before it is closed; omission leaves standard input on the null device. */
  stdin?: string
  /** Standard-output cap for this command; omission uses the configured `maxOutputBytes`. */
  maxOutputBytes?: number
  /**
   * `fail`, the default, rejects a command whose standard output exceeds its cap. `report` resolves
   * with `truncated` set and an empty `stdout` instead.
   */
  overflow?: 'fail' | 'report'
}

/** Complete output of one command whose exit code was allowed. */
export interface CommandResult {
  /** Complete standard output; empty when `truncated`. */
  stdout: string
  /** Standard error, its tail when it exceeded the configured cap. */
  stderr: string
  exitCode: number
  /** Whether standard output exceeded its cap; only an `overflow: 'report'` command resolves with it set. */
  truncated: boolean
}

/** Clear inherited repository, attribute-tree, command-line configuration, and replacement-ref selectors. */
const GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
].map(key => [key, undefined]))

/**
 * Run an argv without a shell and await termination of its managed process range.
 * @param ctx - subprocess and sandbox providers in the same execution world.
 * @param config - complete process resource limits.
 * @param policy - unchanged calling Session policy.
 * @param cwd - canonical process working directory.
 * @param argv - executable followed by literal arguments.
 * @param signal - operation cancellation.
 * @param options - allowed statuses, environment overrides, standard input, and the output cap.
 * @returns complete bounded output and the exit code.
 * @throws when the exit code is not allowed, or standard output exceeds its cap under `overflow: 'fail'`.
 */
export async function runCommand(
  ctx: Context,
  config: ProcessConfig,
  policy: SandboxExecutionPolicy,
  cwd: string,
  argv: readonly [string, ...string[]],
  signal: AbortSignal,
  options: CommandOptions = {},
): Promise<CommandResult> {
  const { allowedExitCodes = [0], env = {}, stdin, maxOutputBytes = config.maxOutputBytes, overflow = 'fail' } = options
  using timeout = deadline(signal, config.timeoutMs, 'WORKTREE_TIMEOUT')
  timeout.signal.throwIfAborted()
  const program = await ctx.subprocess.resolveExecutable(argv[0], undefined, timeout.signal)
  const command = [program, ...argv.slice(1)]
  const wrapped = policy.mode === 'danger-full-access'
    ? command
    : (await ctx.sandbox.confine(command, { ...policy, mode: policy.mode }, timeout.signal)).argv
  timeout.signal.throwIfAborted()
  const child = ctx.subprocess.spawn({
    argv: wrapped,
    cwd,
    env: { ...GIT_ENV, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_LAZY_FETCH: '1', ...env },
    signal: timeout.signal,
    graceMs: config.graceMs,
    stdio: {
      stdin: stdin === undefined ? 'ignore' : { data: stdin },
      stdout: { maxBytes: maxOutputBytes },
      stderr: { maxBytes: config.maxOutputBytes },
    },
  })
  try {
    const outcome = await child.done
    timeout.signal.throwIfAborted()
    // The spawn spec above collects both streams.
    const captured = child.collected as Required<SubprocessCollectedOutputs>
    const stdout = captured.stdout.readFrom(0)
    const stderr = captured.stderr.readFrom(0)
    if (outcome.exitCode === null || !allowedExitCodes.includes(outcome.exitCode)) {
      throw new Error(`worktree command failed (${outcome.signal ?? outcome.exitCode}): ${stderr.text.trim()}`)
    }
    if (stdout.lossy && overflow === 'fail') throw new Error('worktree command output exceeds maxOutputBytes')
    return { stdout: stdout.lossy ? '' : stdout.text, stderr: stderr.text, exitCode: outcome.exitCode, truncated: stdout.lossy }
  } finally {
    child.terminate()
    await child.waitForExit()
  }
}
