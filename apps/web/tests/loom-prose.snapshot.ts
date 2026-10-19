/** Full-profile prose recording: exact auxiliary requests, probabilities, authored alternatives and curation. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import {
  fixtureContext, normalizeSessionSnapshots, redactSessionSnapshotIds, refreshFixtureReplacements,
  scrubSessionSnapshot, stabilizeFixtureMessageIds, stabilizeRefreshLog, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import {
  fixtureUserPrompts, launchWebScaffold, normalizeWebSessionVolatiles, rawSessionLog, readPersistedEvents,
  recordedSessionFixturePath, selectedSessionFixture, webSnapshotMode,
} from './scaffold.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/loom-prose', import.meta.url))
const ANCHOR = fileURLToPath(new URL('../../../packages/experimental/loom-bundle/package.json', import.meta.url))
const MODE = webSnapshotMode()

it.skipIf(MODE === 'record')('replays prose siblings, token alternatives, curation and downloads through the Web profile', async () => {
  const path = await selectedSessionFixture(join(DIR, 'session.v4.jsonl'))
  let expected = await readFile(path, 'utf8')
  const scaffold = await launchWebScaffold({
    extraOverlayPath: join(DIR, 'cordis.snapshot.yml'), extraInstallAnchors: [ANCHOR],
    replayFixture: path, compareReplaySession: false,
    replayProviders: [{ id: 'deepseek-official', name: 'Prose replay', models: [{
      id: 'deepseek-v4-flash', contextWindow: 128_000,
      tokenLogprobs: { maxTopLogprobs: 20 }, assistantPrefill: 'tool-free',
    }] }],
  })
  try {
    const { sessionId } = await scaffold.ctx.sessionController.create({ cwd: scaffold.workspaceCwd })
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Prose primary has no live Agent')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: fixtureUserPrompts(expected)[0]! }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const messages = agent.session.deriveMessages()
    const signal = new AbortController().signal
    const initial = await scaffold.ctx.loom.weave({ sessionId, parent: null, prefix: [{ text: 'The ', author: 'user' }], n: 2 }, signal)
    expect(initial.schedule).toBe('lead-then-burst')
    expect(initial.nodes.map(node => node.text)).toEqual(['wind', 'rain'])
    expect(initial.nodes.every(node => node.status === 'completed' && node.logprobs?.tokens.length === 1)).toBe(true)
    const first = initial.nodes[0]!
    expect(await scaffold.ctx.loom.choose({ sessionId, nodeId: first.id }, signal)).toEqual({ curationBits: 1, modelTokens: 1 })
    const alternative = await scaffold.ctx.loom.weave({ sessionId, parent: first.id,
      prefix: [{ text: 'The ', author: 'user' }, { text: 'sea', author: 'alternative', node: first.id, tokenIndex: 0 }], n: 1 }, signal)
    expect(alternative.nodes[0]?.text).toBe(' waited.')
    expect(await scaffold.ctx.loom.choose({ sessionId, nodeId: alternative.nodes[0]!.id }, signal))
      .toEqual({ curationBits: 1, modelTokens: 2 })
    const probe = await scaffold.ctx.loom.probe({ sessionId, parent: null, prefix: [{ text: 'The ', author: 'user' }], depth: 1 }, signal)
    expect(probe.requests).toBe(1)
    expect(probe.nodes.map(node => node.token)).toEqual(['wind', 'sea'])
    expect((await scaffold.ctx.loom.weaveState({ sessionId }, signal)).nodes).toHaveLength(4)
    expect(agent.session.deriveMessages()).toEqual(messages)
    const records = agent.session.snapshotEvents().map(pluginRecordOf).filter(record => record !== undefined)
    expect(records.filter(record => record.type === 'plugin:loom/weave-request')).toHaveLength(3)
    for (const format of ['json', 'text', 'html'] as const) {
      const download = await scaffold.ctx.loom.export({ sessionId, mode: 'path', nodeId: alternative.nodes[0]!.id, format }, signal)
      expect(download.mimeType).toContain(format === 'json' ? 'application/json' : format === 'html' ? 'text/html' : 'text/plain')
      expect(download.url).toContain('loom')
    }
    await scaffold.ctx.sessions.flush(agent.session)
    expect(await readPersistedEvents(scaffold, sessionId)).toEqual(agent.session.snapshotEvents())
    const raw = normalizeWebSessionVolatiles(rawSessionLog(agent.session), scaffold.workspaceCwd)
    const context = { sessionIds: [String(sessionId)], cwd: scaffold.workspaceCwd }
    if (MODE === 'refresh') {
      const replacements = refreshFixtureReplacements([
        { id: sessionId, createdAt: agent.session.header.createdAt, content: raw },
      ], [expected])
      expected = redactSessionSnapshotIds(stabilizeFixtureMessageIds([tokenizeSessionFixtureCwd(scrubSessionSnapshot(stabilizeRefreshLog(
        prepareSessionSnapshotFixtureForComparison(redactSessionSnapshotIds([raw])[0]!), expected, replacements, context,
      ))).split(scaffold.harnessHome).join('{{harnessHome}}')], [expected]))[0]!
      await writeFile(recordedSessionFixturePath(path, agent.session.header.version), expected)
    }
    expect(normalizeSessionSnapshots([raw], context)).toEqual(normalizeSessionSnapshots([expected], fixtureContext(expected)))
  } finally {
    await scaffold.close()
  }
}, 120_000)
