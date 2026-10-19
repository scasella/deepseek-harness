/**
 * Composition for isolation, compare, diff, adopt, apply, and discard specs:
 * the branch host on the local filesystem, plus real subprocesses, sandbox
 * policy, worktree service, file tools, change summaries, usage projections,
 * a scripted model, and a `bash` tool fixture whose model-facing output and
 * presentation metadata disagree on purpose. Each spec owns the returned
 * Context and every directory it creates.
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WorktreeService from '@deepseek-ai/dsh-experimental-worktree'
import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import * as SessionStats from '@deepseek-ai/dsh-session-stats'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as WorkspaceChanges from '@deepseek-ai/dsh-workspace-changes'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { git, UnusedSandbox } from '../../worktree/tests/harness.ts'
import type { Config } from '../src/index.ts'
import { mountBranchHost, type BranchHost } from './branch-host.ts'

export { git } from '../../worktree/tests/harness.ts'

/** A fresh canonical temporary directory; the caller removes it. */
export async function scratch(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)))
}

/**
 * A repository with one commit holding `notes.txt`, `tracked.txt`, and a binary `keep.bin`.
 * @param root - an empty directory the caller owns.
 */
export async function repository(root: string): Promise<void> {
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'core.autocrlf', 'false')
  await git(root, 'config', 'user.name', 'Loom fixture')
  await git(root, 'config', 'user.email', 'loom@example.invalid')
  await git(root, 'config', 'commit.gpgSign', 'false')
  await writeFile(join(root, 'notes.txt'), 'base\n')
  await writeFile(join(root, 'tracked.txt'), 'tracked\n')
  await writeFile(join(root, 'keep.bin'), Buffer.from([0, 1, 2, 255, 0, 10]))
  await git(root, 'add', '.')
  await git(root, 'commit', '-m', 'initial')
}

/** Text of the last user message of a request that holds a directive line. */
function directive(options: GenerateOptions): string | undefined {
  for (const message of options.messages.toReversed()) {
    if (message.role !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'text' && /^(?:write|bash) /.test(block.text)) return block.text
    }
  }
  return undefined
}

/**
 * Answers a request after a tool result with `done`; otherwise a user line
 * `write <path>: <text>` calls the write tool, `bash <command>` calls the
 * `bash` fixture, and anything else gets `ok`. While `held` names a Session,
 * its requests wait until released.
 */
export class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly held = new Set<string>()
  private readonly waiting = new Map<string, () => void>()

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'mock', name: 'mock' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const sessionId = String(options.sessionId)
    if (this.held.has(sessionId)) {
      await new Promise<void>((resolve, reject) => {
        this.waiting.set(sessionId, resolve)
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
    }
    if (options.messages.at(-1)?.role === 'tool') {
      yield * textResponse('done')
      return
    }
    const line = directive(options)
    const id = `call-${String(this.requests.length)}`
    const write = /^write (\S+): (.*)$/s.exec(line ?? '')
    if (write !== null) {
      yield * toolCallResponse(id, 'write', { file_path: write[1], content: `${write[2]}\n` })
    } else if (line?.startsWith('bash ') === true) {
      yield * toolCallResponse(id, 'bash', { command: line.slice('bash '.length) })
    } else {
      yield * textResponse('ok')
    }
  }

  /** Let the held request of one Session run, and stop holding that Session. */
  release(sessionId: string): void {
    this.held.delete(sessionId)
    this.waiting.get(sessionId)?.()
    this.waiting.delete(sessionId)
  }
}

/** The composition and its fixtures. */
export interface WorkspaceHost extends BranchHost {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  /** Model-facing output of each `bash` fixture command. */
  readonly bash: Map<string, string>
}

/** Choices of one composition. */
export interface WorkspaceHostOptions {
  /** Deployment sandbox mode and fallback workspace root. */
  readonly mode: SandboxMode
  readonly workspaceRoot: string
  readonly config?: Config
  /** Mount the worktree service; default true. */
  readonly worktree?: boolean
  /** Mount the change summaries service; default false. */
  readonly changes?: boolean
  /** Enforce confined modes with the local sandbox instead of refusing every confinement. */
  readonly sandbox?: 'local' | 'unused'
  /** Register the `bash` fixture; default true. */
  readonly bash?: boolean
}

/**
 * Mount the composition on a fresh Context the caller disposes.
 * @param options - sandbox mode, optional services, and Loom configuration.
 * @returns the composition.
 */
export async function mountWorkspaceHost(options: WorkspaceHostOptions): Promise<WorkspaceHost> {
  const ctx = new Context()
  try {
    const host = await mountBranchHost(ctx, { provider: 'mock', model: 'mock' }, options.config, undefined, 'local')
    await ctx.plugin(SessionStats)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(options.sandbox === 'local' ? LocalSandbox : UnusedSandbox)
    await ctx.plugin(SandboxPolicyService, { mode: options.mode, workspaceRoot: options.workspaceRoot })
    if (options.worktree !== false) await ctx.plugin(WorktreeService, {})
    await ctx.plugin(ToolFs)
    if (options.changes === true) await ctx.plugin(WorkspaceChanges)
    const bash = new Map<string, string>()
    if (options.bash !== false) ctx.tools.register(defineTool({
      name: 'bash',
      description: 'Run a fixture command.',
      parameters: { command: { type: 'string', required: true, description: 'The command.' } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
        presentationMeta: () => ({ exitCode: 0, stdout: { text: '=== 99 passed in 0.01s ===', truncated: false } }),
      },
      execute: async args => bash.get(args.command) ?? '',
    }))
    const adapter = new ScriptedAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    return { ...host, ctx, adapter, bash }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

/** Remove fixture directories, retrying while a removed worktree's files settle. */
export async function removeAll(paths: readonly string[]): Promise<void> {
  for (const path of paths) await rm(path, { recursive: true, force: true, maxRetries: 3 })
}
