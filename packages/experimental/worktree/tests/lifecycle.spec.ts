import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { contents, filterCommand, git, harness, repository, testAgent } from './harness.ts'

let ctx: Context | undefined
const roots: string[] = []

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function repo(): Promise<string> {
  const root = await repository()
  roots.push(root)
  return root
}

async function scratch(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'dsh-worktree-scratch-')))
  roots.push(path)
  return path
}

describe('a base commit that includes uncommitted tracked changes', () => {
  it('carries staged and unstaged tracked changes on a commit above HEAD and leaves the source unchanged', async () => {
    const root = await repo()
    await writeFile(join(root, 'second.txt'), 'second\n')
    await git(root, 'add', 'second.txt')
    await git(root, 'commit', '-m', 'second')
    const head = await git(root, 'rev-parse', 'HEAD')
    await writeFile(join(root, 'tracked.txt'), 'staged\n')
    await git(root, 'add', 'tracked.txt')
    await writeFile(join(root, 'second.txt'), 'unstaged\n')
    await writeFile(join(root, 'added.txt'), 'added to the index\n')
    await git(root, 'add', 'added.txt')
    await writeFile(join(root, 'untracked.txt'), 'local\n')
    const status = await git(root, 'status', '--porcelain')
    const index = await git(root, 'ls-files', '--stage')
    const refs = await git(root, 'show-ref')
    ctx = await harness(root)

    const created = await ctx.worktrees.create(testAgent(ctx, root), { name: 'snapshot', includeUncommitted: true })

    expect(created.baseCommit).not.toBe(head)
    expect(await git(root, 'rev-parse', `${created.baseCommit}^@`)).toBe(head)
    expect(await git(root, 'log', '-1', '--format=%an <%ae>|%s', created.baseCommit)).toBe('dsh worktree <worktree@dsh.invalid>|dsh worktree snapshot')
    expect(await contents(join(created.path, 'tracked.txt'))).toBe('staged\n')
    expect(await contents(join(created.path, 'second.txt'))).toBe('unstaged\n')
    expect(await contents(join(created.path, 'added.txt'))).toBe('added to the index\n')
    await expect(access(join(created.path, 'untracked.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git(root, 'status', '--porcelain')).toBe(status)
    expect(await git(root, 'ls-files', '--stage')).toBe(index)
    expect(await git(root, 'show-ref')).toBe(`${refs}\n${created.baseCommit} refs/heads/snapshot`)
    expect(await git(root, 'stash', 'list')).toBe('')
    expect(await contents(join(root, 'second.txt'))).toBe('unstaged\n')
  })

  it('uses HEAD when no tracked file differs from it, even with an index that once did', async () => {
    const root = await repo()
    const head = await git(root, 'rev-parse', 'HEAD')
    await writeFile(join(root, 'untracked.txt'), 'local\n')
    ctx = await harness(root)
    const clean = await ctx.worktrees.create(testAgent(ctx, root, 'clean'), { name: 'clean', includeUncommitted: true })
    expect(clean.baseCommit).toBe(head)

    await writeFile(join(root, 'tracked.txt'), 'staged\n')
    await git(root, 'add', 'tracked.txt')
    await writeFile(join(root, 'tracked.txt'), 'initial\n')
    const reverted = await ctx.worktrees.create(testAgent(ctx, root, 'reverted'), { name: 'reverted', includeUncommitted: true })
    expect(reverted.baseCommit).toBe(head)
  })

  it('runs no configured clean filter while it records the changes', async () => {
    const root = await repo()
    await writeFile(join(root, '.gitattributes'), '*.txt filter=configured\n')
    await git(root, 'add', '.gitattributes')
    await git(root, 'commit', '-m', 'attributes')
    const { command, marker } = await filterCommand(root)
    await git(root, 'config', 'filter.configured.clean', command)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    ctx = await harness(root)
    const created = await ctx.worktrees.create(testAgent(ctx, root), { name: 'unfiltered', includeUncommitted: true })
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await contents(join(created.path, 'tracked.txt'))).toBe('changed\n')
  })

  it('refuses a revision together with uncommitted changes before any command', async () => {
    const root = await repo()
    ctx = await harness(root)
    await expect(ctx.worktrees.create(testAgent(ctx, root), { name: 'both', from: 'HEAD', includeUncommitted: true }))
      .rejects.toThrow('worktree includeUncommitted requires from to be omitted')
    expect(await git(root, 'branch', '--list', 'both')).toBe('')
  })
})

describe('locating the repository of a directory', () => {
  it('finds the nearest .git directory or file at or above a directory', async () => {
    const root = await repo()
    await mkdir(join(root, 'nested/deeper'), { recursive: true })
    const linked = join(root, 'linked')
    await git(root, 'worktree', 'add', '-b', 'linked', linked)
    ctx = await harness(root)

    expect(await ctx.worktrees.locate(root)).toEqual({ root, administration: 'directory' })
    expect(await ctx.worktrees.locate(join(root, 'nested/deeper'))).toEqual({ root, administration: 'directory' })
    expect(await ctx.worktrees.locate(linked)).toEqual({ root: linked, administration: 'file' })
  })

  it('reports no repository for a missing directory or a file', async () => {
    const root = await repo()
    ctx = await harness(root)
    expect(await ctx.worktrees.locate(join(root, 'missing/deeper'))).toBeUndefined()
    expect(await ctx.worktrees.locate(join(root, 'tracked.txt'))).toBeUndefined()
  })

  it('reports no repository above a plain directory and skips a .git symlink', async () => {
    const plain = await scratch()
    await mkdir(join(plain, 'inner'))
    await symlink(join(plain, 'inner'), join(plain, 'inner', '.git'))
    ctx = await harness(plain)
    expect(await ctx.worktrees.locate(join(plain, 'inner'))).toBeUndefined()
  })
})

describe('removing a linked checkout', () => {
  it('removes the checkout and its branch, moving the caller out first, and keeps every other checkout', async () => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    const kept = await ctx.worktrees.create(testAgent(ctx, root, 'other'), { name: 'kept' })
    const created = await ctx.worktrees.create(agent, { name: 'loom/child' })
    await writeFile(join(created.path, 'tracked.txt'), 'modified\n')
    await writeFile(join(created.path, 'new.txt'), 'untracked\n')
    await mkdir(join(created.path, 'sub'))
    await ctx.workingDirectory.set(agent, join(created.path, 'sub'))

    expect(await ctx.worktrees.remove(agent, created)).toEqual({ kind: 'removed' })

    await expect(access(created.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git(root, 'branch', '--list', 'loom/child')).toBe('')
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    expect(await contents(join(kept.path, 'tracked.txt'))).toBe('initial\n')
    expect(await git(root, 'branch', '--list', 'kept')).toBe('+ kept')
    expect(await git(root, 'worktree', 'list', '--porcelain')).toContain(`worktree ${kept.path}`)
    expect(await contents(join(root, 'tracked.txt'))).toBe('initial\n')
  })

  it('keeps the caller where it is when its directory is outside the checkout', async () => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    const created = await ctx.worktrees.create(testAgent(ctx, root, 'creator'), { name: 'elsewhere' })
    expect(await ctx.worktrees.remove(agent, created)).toEqual({ kind: 'removed' })
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    expect(await git(root, 'branch', '--list', 'elsewhere')).toBe('')
  })

  it('changes nothing for the main checkout, an unknown path, or a different branch', async () => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    const created = await ctx.worktrees.create(testAgent(ctx, root, 'creator'), { name: 'present' })
    await git(root, 'branch', 'other')

    expect(await ctx.worktrees.remove(agent, { path: root, branch: 'main', repositoryRoot: root })).toEqual({ kind: 'missing' })
    expect(await ctx.worktrees.remove(agent, { ...created, path: join(root, 'absent') })).toEqual({ kind: 'missing' })
    expect(await ctx.worktrees.remove(agent, { ...created, branch: 'other' })).toEqual({ kind: 'missing' })

    expect(await contents(join(created.path, 'tracked.txt'))).toBe('initial\n')
    expect(await git(root, 'branch', '--list', 'present', 'other', 'main')).toBe('* main\n  other\n+ present')
  })

  it('rejects a branch that is not a relative branch name before any command', async () => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    for (const branch of ['-D', '../escape', '']) {
      await expect(ctx.worktrees.remove(agent, { path: root, branch, repositoryRoot: root }))
        .rejects.toThrow('worktree branch must be a relative Git branch name')
    }
  })
})

describe('hardened Git commands', () => {
  it('passes standard input, returns both streams, and accepts listed exit codes', async () => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    const hashed = await ctx.worktrees.git(agent, { cwd: root, args: ['hash-object', '-w', '--stdin'], stdin: 'payload\n' })
    expect(hashed).toMatchObject({ stderr: '', exitCode: 0, truncated: false })
    expect(await git(root, 'cat-file', '-p', hashed.stdout.trim())).toBe('payload')

    const failing = await ctx.worktrees.git(agent, { cwd: root, args: ['rev-parse', '--verify', '--quiet', 'missing'], allowedExitCodes: [1] })
    expect(failing).toMatchObject({ stdout: '', exitCode: 1, truncated: false })
    await expect(ctx.worktrees.git(agent, { cwd: root, args: ['rev-parse', '--verify', 'missing'] }))
      .rejects.toThrow(/worktree command failed \(128\): fatal: /)
  })

  it('reports output beyond its cap as truncated with empty standard output', async () => {
    const root = await repo()
    ctx = await harness(root)
    const agent = testAgent(ctx, root)
    const capped = await ctx.worktrees.git(agent, { cwd: root, args: ['cat-file', '-p', 'HEAD:tracked.txt'], maxOutputBytes: 3 })
    expect(capped).toEqual({ stdout: '', stderr: '', exitCode: 0, truncated: true })
    for (const maxOutputBytes of [0, 1.5, -1]) {
      await expect(ctx.worktrees.git(agent, { cwd: root, args: ['status'], maxOutputBytes }))
        .rejects.toThrow('worktree git maxOutputBytes must be a positive integer')
    }
  })

  it('runs configured filters only when they are not disabled', async () => {
    const root = await repo()
    await writeFile(join(root, '.gitattributes'), '*.txt filter=configured\n')
    await git(root, 'add', '.gitattributes')
    await git(root, 'commit', '-m', 'attributes')
    const { command, marker } = await filterCommand(root)
    await git(root, 'config', 'filter.configured.clean', command)
    await writeFile(join(root, 'tracked.txt'), 'changed\n')
    ctx = await harness(root)
    const agent = testAgent(ctx, root)

    const disabled = await ctx.worktrees.git(agent, { cwd: root, args: ['diff', '--numstat', 'HEAD'], disableFilters: true })
    expect(disabled.stdout).toBe('1\t1\ttracked.txt\n')
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })

    await ctx.worktrees.git(agent, { cwd: root, args: ['diff', '--numstat', 'HEAD'] })
    expect(await contents(marker)).toContain('executed')
  })
})
