#!/usr/bin/env node
/**
 * Autoloom Loader driver: boot the shipped Web profile with the Loom bundle
 * patch and the test patch, run one story turn, run one weaver turn that the
 * fixture model drives through the autoloom tools, and write what the
 * composed services recorded to `autoloom-report.json`.
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context, FiberState } from '@deepseek-ai/cordis'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-client-modules'
import type {} from '../../../src/index.ts'
import { bootProductionProfile } from '../../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'
import { REPORT, type AutoloomLoaderReport, type ReportedChild } from './files.ts'

const NAME = 'autoloom-loader-smoke'
// FiberState is a type-only const enum under isolated transpilation.
const FIBER_ACTIVE = 2 as FiberState.ACTIVE
const configPath = process.argv[2]
if (configPath === undefined) throw new Error(`${NAME}: expected <config-path>`)
const bundlePatch = fileURLToPath(new URL('../../../../loom-bundle/cordis.patch.yml', import.meta.url))

const worktreePatch = fileURLToPath(new URL('../../../../tool-worktree/cordis.patch.yml', import.meta.url))
const orderedBundles = process.env['DSH_LOOM_BUNDLE_ORDER'] === 'loom-first' ? [bundlePatch, worktreePatch] : [worktreePatch, bundlePatch]

const ctx = await bootProductionProfile({
  binName: NAME,
  profile: 'web',
  overlayPaths: [...orderedBundles, resolveConfigPath(configPath, undefined)],
  prepare: (root) => {
    provideCmdline(root, {
      args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
      exit: (code) => { throw new Error(`${NAME}: unexpected exit request ${String(code)}`) },
    })
  },
})

async function promptAndSettle(root: Context, sessionId: SessionId, text: string): Promise<void> {
  await root.sessionController.prompt({
    requestId: `${sessionId}-${text}` as SessionRequestId,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  }, new AbortController().signal)
  const found = await root.sessionController.resolveAgent(sessionId)
  if ('error' in found) throw found.error
  await found.agent.whenIdle()
}

try {
  const entries = [...ctx.loader.entries()]
    .filter(entry => entry.options.id === 'loom' || entry.options.id === 'tool-loom')
    .map(entry => ({ id: entry.options.id, active: entry.fiber?.state === FIBER_ACTIVE }))
  const { sessionId: storyId } = await ctx.sessionController.create({ cwd: process.cwd() })
  await promptAndSettle(ctx, storyId, 'Write the first line of a story.')
  const search = await ctx.sessionController.search({
    query: 'first line', scope: 'own', sessionIds: [storyId],
  }, new AbortController().signal)
  const { sessionId: weaverId } = await ctx.sessionController.create({ cwd: process.cwd() })
  await promptAndSettle(ctx, weaverId, `WEAVE ${storyId}`)
  const weaver = await ctx.sessionController.inspect(weaverId)
  const weaverCalls = weaver.events.flatMap(event => event.type === 'assistant/message'
    ? event.data.message.content.flatMap(block => block.type === 'tool-call' ? [block.name] : [])
    : [])
  const weaverResults = weaver.events.flatMap(event => event.type === 'tool/result'
    ? [JSON.stringify(event.data).slice(0, 400)]
    : [])
  const children: ReportedChild[] = []
  for (const session of ctx.sessions.list()) {
    if (session.header.parentSession !== storyId) continue
    const inspection = await ctx.sessionController.inspect(session.id)
    const own = inspection.events.slice(inspection.inheritedEventCount)
    const prompt = own.find((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    children.push({
      sessionId: session.id,
      parentSession: session.header.parentSession,
      ownTypes: own.map(event => event.type),
      source: prompt?.data.source,
      mark: ctx.sessionProjections.stateOf(session, 'loomMark')?.mark?.mark ?? null,
      preset: ctx.permissionPresets.current(session),
    })
  }
  const report: AutoloomLoaderReport = {
    entries,
    storyId,
    searched: search.items.map(item => item.sessionId),
    weaverId,
    toolNames: ctx.tools.schemas().map(schema => schema.name).filter(toolName => toolName.startsWith('loom_')).sort(),
    weaverCalls,
    weaverResults,
    children,
    archived: [...ctx.workspaceRegistry.archivedSessionIds],
  }
  await writeFile(REPORT, JSON.stringify(report))
} finally {
  await ctx.fiber.dispose()
}
