#!/usr/bin/env node
/**
 * Loom Loader driver: boot the shipped Web profile with the Loom bundle patch
 * and the test patch, prompt a root Session, fork it, prompt the child, and
 * write request views and scoped content-search results to `loom-report.json`.
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context, FiberState } from '@deepseek-ai/cordis'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-modules'
import type {} from '../../../src/index.ts'
import { bootProductionProfile } from '../../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'
import { REPORT } from './files.ts'

const NAME = 'loom-loader-smoke'
// FiberState is a type-only const enum under isolated transpilation.
const FIBER_ACTIVE = 2 as FiberState.ACTIVE
const configPath = process.argv[2]
if (configPath === undefined) throw new Error(`${NAME}: expected <config-path>`)
const bundlePatch = fileURLToPath(new URL('../../../../loom-bundle/cordis.patch.yml', import.meta.url))

const ctx = await bootProductionProfile({
  binName: NAME,
  profile: 'web',
  overlayPaths: [bundlePatch, resolveConfigPath(configPath, undefined)],
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
    .filter(entry => entry.options.id === 'loom' || entry.options.id === 'ui-loom')
    .map(entry => ({ id: entry.options.id, name: entry.options.name, active: entry.fiber?.state === FIBER_ACTIVE }))
  const signal = new AbortController().signal
  const { sessionId: rootId } = await ctx.sessionController.create({ cwd: process.cwd() })
  await promptAndSettle(ctx, rootId, 'first prompt')
  const { sessionId: childId } = await ctx.sessionController.fork({ sessionId: rootId })
  await promptAndSettle(ctx, childId, 'second prompt')
  const child = await ctx.sessionController.inspect(childId, signal)
  const settlements = child.events.filter(event => event.type === 'assistant/message').map(event => event.seq)
  const views = await Promise.all(settlements.map(seq => ctx.loom.requestAt({ sessionId: childId, seq }, signal)))
  const outOfRange = await ctx.loom.requestAt({ sessionId: childId, seq: SessionSeq(child.events.length) }, signal)
    .then(() => undefined, (error: unknown) => remoteErrorOf(error)?.code)
  const searchIds = async (query: string, scope: 'own' | 'inherited') => (
    await ctx.sessionController.search({ query, scope, sessionIds: [childId] }, signal)
  ).items.map(item => item.sessionId)
  const search = {
    own: await searchIds('second prompt', 'own'),
    inherited: await searchIds('first prompt', 'inherited'),
    excludedInherited: await searchIds('first prompt', 'own'),
    excludedOwn: await searchIds('second prompt', 'inherited'),
  }
  await writeFile(REPORT, JSON.stringify({
    entries,
    clientRoster: ctx.clientModules.graph().entries.map(entry => entry.id),
    rootId,
    childId,
    inheritedEventCount: child.inheritedEventCount,
    settlements,
    views,
    outOfRange,
    search,
  }))
} finally {
  await ctx.fiber.dispose()
}
