/** Authored full-profile autoloom recording: tool decisions, child permissions, marks, and archive effects. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'
import { pluginRecordOf, type Session } from '@deepseek-ai/dsh-session'
import {
  fixtureContext, normalizeSessionSnapshots, normalizedSystemPrompts, normalizedToolSchemas,
  formatSystemPromptSnapshot, formatToolSchemasSnapshot, parseToolSchemasSnapshot, redactSessionSnapshotIds,
  refreshFixtureReplacements, scrubSessionSnapshot, stabilizeFixtureMessageIds, stabilizeRefreshLog, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import {
  fixtureUserPrompts, launchWebScaffold, normalizeWebSessionVolatiles, rawSessionLog, readPersistedEvents,
  recordedSessionFixturePath, selectedSessionFixture, webSnapshotMode,
} from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/loom-autoloom', import.meta.url))
const ANCHOR = fileURLToPath(new URL('../../../packages/experimental/loom-bundle/package.json', import.meta.url))
const MODE = webSnapshotMode()

it.skipIf(MODE === 'record')('replays autoloom expansion, reading, curation, and archival through the shipped Web profile', async () => {
  const paths = await Promise.all(['session.v4.jsonl', 'session.1.v4.jsonl', 'session.2.v4.jsonl']
    .map(file => selectedSessionFixture(join(DIR, file))))
  let expected = await Promise.all(paths.map(path => readFile(path, 'utf8')))
  const scaffold = await launchWebScaffold({
    extraOverlayPath: join(DIR, 'cordis.snapshot.yml'), extraInstallAnchors: [ANCHOR],
    replayFixture: paths[0]!, replayChildFixtures: paths.slice(1), replayOverride: join(DIR, 'replay.override.json'),
    compareReplaySession: false,
  })
  try {
    const sessions: Session[] = []
    scaffold.ctx.on('session/created', (session) => { sessions.push(session) })
    const { sessionId } = await scaffold.ctx.sessionController.create({ cwd: scaffold.workspaceCwd })
    const parent = scaffold.ctx.agents.get(sessionId)
    if (parent === undefined) throw new Error('Autoloom primary has no live Agent')
    const prompts = fixtureUserPrompts(expected[0]!)
    expect(prompts).toHaveLength(2)
    for (const prompt of prompts) {
      parent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
      await parent.whenIdle()
    }
    expect(sessions).toHaveLength(3)
    for (const child of sessions.slice(1)) await scaffold.ctx.agents.get(child.id)?.whenIdle()
    const primaryEvents = parent.session.snapshotEvents()
    expect(primaryEvents.filter(event => event.type === 'tool/call').map(event => event.data.name))
      .toEqual(['loom_expand', 'loom_wait', 'loom_read', 'loom_read', 'loom_keep', 'loom_cull'])
    expect(primaryEvents.filter(event => event.type === 'tool/result').every(event => !event.data.message.isError)).toBe(true)
    for (const child of sessions.slice(1)) {
      const own = child.snapshotEvents().slice(child.inheritedEventCount)
      const permission = own.findIndex(event => event.type === 'permission/preset' && event.data.preset === 'loom-child')
      const prompt = own.findIndex(event => event.type === 'user/message' && event.data.source.kind === 'loom')
      expect(permission).toBeGreaterThanOrEqual(0)
      expect(prompt).toBeGreaterThan(permission)
    }
    expect(sessions[1]!.snapshotEvents().some((event) => {
      const record = pluginRecordOf(event)
      return record?.type === 'plugin:loom/mark' && record.data !== null && typeof record.data === 'object'
        && 'mark' in record.data && record.data.mark === 'keep'
    })).toBe(true)
    expect(scaffold.ctx.workspaceRegistry.archivedSessionIds).toContain(sessions[2]!.id)
    for (const session of sessions) {
      await scaffold.ctx.sessions.flush(session)
      expect(await readPersistedEvents(scaffold, session.id)).toEqual(session.snapshotEvents())
    }
    const raw = sessions.map(session => normalizeWebSessionVolatiles(rawSessionLog(session), scaffold.workspaceCwd))
    const context = { sessionIds: sessions.map(session => String(session.id)), cwd: scaffold.workspaceCwd }
    const schemas = normalizedToolSchemas(raw[0]!, context)[0]
    const prompt = normalizedSystemPrompts(raw[0]!, context)[0]
    if (schemas === undefined || prompt === undefined) throw new Error('Autoloom recording lacks its model request')
    const normalizedPrompt = formatSystemPromptSnapshot(
      prompt.split(REPO_ROOT).join('{{sourceRoot}}').split(scaffold.baseUrl).join('{{webUrl}}'),
    )
    if (MODE === 'refresh') {
      await writeFile(join(DIR, 'tool-schemas.expected.json'), formatToolSchemasSnapshot(schemas))
      await writeFile(join(DIR, 'system-prompt.expected.md'), normalizedPrompt)
      const replacements = refreshFixtureReplacements(raw.map((content, index) => ({
        id: sessions[index]!.id, createdAt: sessions[index]!.header.createdAt, content,
      })), expected)
      expected = redactSessionSnapshotIds(stabilizeFixtureMessageIds(raw.map((log, index) => {
        const stabilized = stabilizeRefreshLog(prepareSessionSnapshotFixtureForComparison(log), expected[index]!, replacements, context)
        return tokenizeSessionFixtureCwd(scrubSessionSnapshot(stabilized)).split(scaffold.harnessHome).join('{{harnessHome}}')
      }), expected))
      await Promise.all(expected.map((log, index) => writeFile(
        recordedSessionFixturePath(paths[index]!, sessions[index]!.header.version), log,
      )))
    }
    expect(schemas).toEqual(parseToolSchemasSnapshot(await readFile(join(DIR, 'tool-schemas.expected.json'), 'utf8')).initial)
    expect(normalizedPrompt).toBe(await readFile(join(DIR, 'system-prompt.expected.md'), 'utf8'))
    expect(normalizeSessionSnapshots(raw, context)).toEqual(normalizeSessionSnapshots(expected, fixtureContext(expected[0]!)))
  } finally {
    await scaffold.close()
  }
}, 120_000)
