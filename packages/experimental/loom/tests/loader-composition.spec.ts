/**
 * REAL-composition tier (packages/AGENTS.md): boot the shipped Web profile
 * with the Loom bundle patch as a subprocess through the same app/boot path
 * a deployment uses, prompt and fork a Session through the composed Session
 * Controller, and compare `loom.requestAt` with the requests the agent loop
 * sent on the fixture route.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'
import { messageText } from '../src/request-at.ts'
import type { LoomRequestView } from '../src/types.ts'
import { REPORT, REQUEST_LOG, type LoggedRequest } from './fixtures/loader/files.ts'
import { requestRows } from './request-rows.ts'

const driver = fileURLToPath(new URL('./fixtures/loader/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/loader/loom.patch.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

interface LoomLoaderReport {
  readonly entries: readonly { readonly id: string; readonly name: string; readonly active: boolean }[]
  readonly clientRoster: readonly string[]
  readonly rootId: string
  readonly childId: string
  readonly inheritedEventCount: number
  readonly settlements: readonly number[]
  readonly views: readonly LoomRequestView[]
  readonly outOfRange: string | undefined
  readonly search: {
    readonly own: readonly string[]
    readonly inherited: readonly string[]
    readonly excludedInherited: readonly string[]
    readonly excludedOwn: readonly string[]
  }
}

describe('Loom through a real Loader composition', () => {
  // The Web profile composes far more rows than the default 30s smoke
  // window assumes on a loaded coverage lane; vitest keeps 15s of headroom.
  const processTimeoutMs = 90_000
  it('mounts from the bundle patch and rebuilds the requests a forked Session sent', async () => {
    let report: LoomLoaderReport | undefined
    let requests: LoggedRequest[] = []
    const { stderr } = await runLoaderSmoke({
      label: 'loom loader smoke',
      tempDirPrefix: 'loom-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      processTimeoutMs,
      inspect: async (cwd) => {
        report = JSON.parse(await readFile(join(cwd, REPORT), 'utf8')) as LoomLoaderReport
        requests = (await readFile(join(cwd, REQUEST_LOG), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as LoggedRequest)
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    if (report === undefined) throw new Error('the Loom driver wrote no report')
    expect([...report.entries].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'loom', name: '@deepseek-ai/dsh-experimental-loom', active: true },
      { id: 'ui-loom', name: '@deepseek-ai/dsh-experimental-client-ui-loom', active: true },
    ])
    expect(report.clientRoster).toContain('@deepseek-ai/dsh-experimental-client-ui-loom')
    expect(report.outOfRange).toBe('loom/seq-out-of-range')
    expect(report.search).toEqual({
      own: [report.childId],
      inherited: [report.childId],
      excludedInherited: [],
      excludedOwn: [],
    })

    const [rootRequest, ...rootRest] = requests.filter(request => request.sessionId === report?.rootId)
    const [childRequest, ...childRest] = requests.filter(request => request.sessionId === report?.childId)
    expect([rootRest, childRest]).toEqual([[], []])
    const [inherited, own] = report.views
    expect(report.views).toHaveLength(2)
    expect(report.settlements[0]).toBeLessThan(report.inheritedEventCount)
    expect(report.settlements[1]).toBeGreaterThanOrEqual(report.inheritedEventCount)

    for (const [view, request] of [[inherited!, rootRequest!], [own!, childRequest!]] as const) {
      expect(view.route).toEqual({ provider: 'loom-mock', model: 'loom-mock' })
      expect(view.route).toMatchObject({ provider: request.provider, model: request.model })
      expect(view.tools.names).toEqual(request.toolNames)
      expect(view.messages.map(({ role, preview, chars }) => ({ role, preview, chars }))).toEqual(requestRows(request.messages))
      expect(view.messages.map(message => message.inherited))
        .toEqual(view.messages.map(message => message.seq < report!.inheritedEventCount))
      const system = request.messages.findLast(message => message.role === 'system')
      expect(view.systemPrompt.text).toBe(system === undefined ? '' : messageText(system))
    }
    expect(inherited).toMatchObject({ inheritedTurns: 1, ownTurns: 0 })
    expect(inherited!.messages.every(message => message.inherited)).toBe(true)
    expect(own).toMatchObject({ inheritedTurns: 1, ownTurns: 1 })
    expect(own!.messages.at(-1)).toMatchObject({ role: 'user', preview: 'second prompt', inherited: false })
  }, processTimeoutMs + 15_000)
})
