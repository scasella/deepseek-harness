/**
 * REAL-composition tier (packages/AGENTS.md): boot the shipped Web profile
 * with the Loom bundle patch and a test patch that inserts the autoloom tools
 * as a subprocess, through the same app/boot path a deployment uses, and let
 * a fixture model weave a story through the composed Session Controller,
 * Loom service, permission presets, and Workspace registry.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'
import { REPORT, type AutoloomLoaderReport } from './fixtures/loader/files.ts'

const driver = fileURLToPath(new URL('./fixtures/loader/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/loader/autoloom.patch.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('autoloom through a real Loader composition', () => {
  // The Web profile composes far more rows than the default 30s smoke window assumes on a loaded coverage lane.
  const processTimeoutMs = 90_000
  it.each(['loom-first', 'worktree-first'])('coexists with the Worktree bundle (%s) and weaves, keeps, and archives children', async (order) => {
    let report: AutoloomLoaderReport | undefined
    const { stderr } = await runLoaderSmoke({
      label: 'autoloom loader smoke',
      tempDirPrefix: 'autoloom-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      env: { DSH_LOOM_BUNDLE_ORDER: order },
      tsconfigPath: repoTsconfig,
      processTimeoutMs,
      inspect: async (cwd) => {
        report = JSON.parse(await readFile(join(cwd, REPORT), 'utf8')) as AutoloomLoaderReport
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    if (report === undefined) throw new Error('the autoloom driver wrote no report')
    expect(report.entries.toSorted((left, right) => left.id.localeCompare(right.id))).toEqual([{ id: 'loom', active: true }, { id: 'tool-loom', active: true }])
    expect(report.toolNames).toEqual(['loom_cull', 'loom_expand', 'loom_keep', 'loom_read', 'loom_wait'])
    expect(report.weaverCalls).toEqual(['loom_expand', 'loom_wait', 'loom_read', 'loom_keep', 'loom_cull'])
    expect(report.searched).toEqual([report.storyId])
    expect(report.children).toHaveLength(2)
    const [kept, culled] = report.children
    for (const child of report.children) {
      expect(child.parentSession).toBe(report.storyId)
      expect(child.source).toEqual({ kind: 'loom', weaver: report.weaverId, callId: 'weave-1' })
      expect(child.preset).toBe('loom-child')
      const record = child.ownTypes.indexOf('plugin:loom/branch')
      const preset = child.ownTypes.indexOf('permission/preset')
      const approval = child.ownTypes.indexOf('approval/policy')
      const prompt = child.ownTypes.indexOf('agent/inbox/spliced')
      expect([record >= 0, record < preset, preset < approval, approval < prompt]).toEqual([true, true, true, true])
    }
    expect([kept?.mark, culled?.mark]).toEqual(['keep', null])
    expect(report.archived, report.weaverResults.join('\n')).toEqual([culled?.sessionId])
  }, processTimeoutMs + 15_000)
})
