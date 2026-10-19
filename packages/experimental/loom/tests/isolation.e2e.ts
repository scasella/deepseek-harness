/**
 * Real-API e2e for worktree isolation on the OpenRouter DeepSeek route: a
 * source Session in a temporary Git repository with one tiny file, then a
 * steer set of two worktree children that each write that file differently
 * with the write tool. Asserts distinct worktree contents, compare rows with
 * Git diffs, an apply of one child into the source folder, and removal of
 * both worktrees. Gated on `OPENROUTER_DEEPSEEK_API_KEY`; thinking is off and
 * every prompt asks for one tool call and a one-word reply.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import type { LoomBranchRequestId } from '../src/types.ts'
import { git, mountWorkspaceHost, removeAll, scratch, type WorkspaceHost } from './workspace-host.ts'

const SIGNAL = new AbortController().signal
const PROVIDER = 'openrouter-deepseek'
const MODEL = 'deepseek/deepseek-v4.1-flash-1017'
const key = process.env.OPENROUTER_DEEPSEEK_API_KEY
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const LINES = ['A', 'B'].map(name =>
  `Use the write tool to replace the whole content of the file greeting.txt in the current directory with exactly this one line: hello from branch ${name}. Do not use any other tool. After the write succeeds, reply with only the word done.`)

describe.skipIf(key === undefined || key === '')('Loom worktree isolation (real API)', () => {
  it('runs two children in their own worktrees, compares their diffs, applies one, and removes both', async () => {
    const root = await scratch('dsh-loom-isolation-e2e-')
    cleanups.push(() => removeAll([root]))
    await git(root, 'init', '-b', 'main')
    await git(root, 'config', 'user.name', 'Loom e2e')
    await git(root, 'config', 'user.email', 'loom-e2e@example.invalid')
    await git(root, 'config', 'commit.gpgSign', 'false')
    await writeFile(join(root, 'greeting.txt'), 'hello\n')
    await git(root, 'add', 'greeting.txt')
    await git(root, 'commit', '-m', 'initial')

    const h: WorkspaceHost = await mountWorkspaceHost({ mode: 'danger-full-access', workspaceRoot: root, bash: false })
    cleanups.push(() => h.ctx.fiber.dispose())
    await h.ctx.plugin(LlmPiAi, {
      providers: {
        [PROVIDER]: {
          apiKeyEnv: 'OPENROUTER_DEEPSEEK_API_KEY',
          api: 'openai-completions',
          baseURL: 'https://openrouter.ai/api/v1',
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: true,
            supportsUsageInStreaming: true,
            maxTokensField: 'max_tokens',
            thinkingFormat: 'openrouter',
          },
          openRouterProvider: { order: ['deepseek'], allowFallbacks: false },
          models: [{
            id: MODEL,
            contextWindow: 1_048_576,
            maxTokens: 393_216,
            reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
          }],
        },
      },
    })
    const source = await h.agents.create(SessionId('loom-isolation-e2e-source'), {
      provider: PROVIDER, model: MODEL, reasoningEffort: ReasoningEffortId('off'), maxTokens: 256,
    }, { cwd: root })
    setSandboxMode(source.session, 'danger-full-access')
    source.followup(createUserMessage({ content: [{ type: 'text', text: 'Reply with only the word ready.' }], source: { kind: 'user' } }))
    await source.whenIdle()

    const value = await h.ctx.loom.branch({
      sessionId: source.id, requestId: brandString<LoomBranchRequestId>('isolation-e2e'), kind: 'steer', afterTurn: 1, lines: LINES, isolation: 'worktree',
    })
    const children = value.children.map((child) => {
      if (child.state !== 'started') throw new Error(`child ${String(child.index)} did not start: ${JSON.stringify(child)}`)
      return h.ctx.agents.get(child.sessionId)!
    })
    for (const child of children) await child.whenIdle()
    const worktrees = children.map(child => h.ctx.workingDirectory.get(child.session))
    expect(new Set(worktrees).size).toBe(2)
    const contents = await Promise.all(worktrees.map(path => readFile(join(path, 'greeting.txt'), 'utf8')))
    expect(contents[0]).toContain('hello from branch A')
    expect(contents[1]).toContain('hello from branch B')
    expect(await readFile(join(root, 'greeting.txt'), 'utf8')).toBe('hello\n')

    const { rows } = await h.ctx.loom.compare({ sessionId: children[0]!.id }, SIGNAL)
    expect(rows.map(row => row.sessionId)).toEqual(children.map(child => child.id))
    for (const row of rows) {
      expect(row).toMatchObject({ kind: 'steer', isolation: 'worktree', running: false })
      expect(row.diff?.source).toBe('worktree')
      expect(row.diff?.files.map(file => file.path)).toContain('greeting.txt')
      expect(row.own.steps).toBeGreaterThan(0)
    }
    console.info(`loom isolation e2e: rows ${JSON.stringify(rows.map(row => ({ diff: row.diff, own: row.own })))}`)

    expect((await h.ctx.loom.apply({ sessionId: children[0]!.id })).applied.map(file => file.path)).toContain('greeting.txt')
    expect(await readFile(join(root, 'greeting.txt'), 'utf8')).toBe(contents[0])
    await h.ctx.loom.discard({ sessionId: children[1]!.id })
    expect(await git(root, 'worktree', 'list', '--porcelain')).not.toContain('.agents/worktrees')
    expect(await git(root, 'branch', '--list', 'loom/*')).toBe('')
  }, 240_000)
})
