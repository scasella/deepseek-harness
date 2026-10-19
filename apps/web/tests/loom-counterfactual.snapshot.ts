/** Full-profile tool-result replacement and a message-free continuation in a preserved fork. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'
import { foldSurface, pluginRecordOf } from '@deepseek-ai/dsh-session'
import {
  fixtureContext, normalizeSessionSnapshots, redactSessionSnapshotIds, refreshFixtureReplacements,
  scrubSessionSnapshot, stabilizeFixtureMessageIds, stabilizeRefreshLog, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import {
  fixtureUserPrompts, launchWebScaffold, normalizeWebSessionVolatiles, rawSessionLog, readPersistedEvents,
  recordedSessionFixturePath, selectedSessionFixture, webSnapshotMode,
} from './scaffold.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/loom-counterfactual', import.meta.url))
const ANCHOR = fileURLToPath(new URL('../../../packages/experimental/loom-bundle/package.json', import.meta.url))
const MODE = webSnapshotMode()

it.skipIf(MODE === 'record')('replays a content-only result replacement and continues from the recorded tool output', async () => {
  const paths = await Promise.all(['session.v4.jsonl', 'session.1.v4.jsonl'].map(file => selectedSessionFixture(join(DIR, file))))
  let expected = await Promise.all(paths.map(path => readFile(path, 'utf8')))
  const scaffold = await launchWebScaffold({
    extraOverlayPath: join(DIR, 'cordis.snapshot.yml'), extraInstallAnchors: [ANCHOR],
    replayFixture: paths[0]!, replayChildFixtures: paths.slice(1), compareReplaySession: false,
  })
  try {
    const requests: GenerateOptions[] = []
    scaffold.ctx.on('llm/stream', (options, next) => { requests.push(options); return next() })
    const { sessionId } = await scaffold.ctx.sessionController.create({ cwd: scaffold.workspaceCwd })
    const parent = scaffold.ctx.agents.get(sessionId)
    if (parent === undefined) throw new Error('Counterfactual primary has no live Agent')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: fixtureUserPrompts(expected[0]!)[0]! }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const original = parent.session.snapshotEvents()
    const result = original.find(event => event.type === 'tool/result')
    if (result?.type !== 'tool/result') throw new Error('The original branch has no tool result')
    expect(result.data.message.content).toEqual([{ type: 'text', text: 'alpha\n' }])
    const value = await scaffold.ctx.loom.counterfactual({ sessionId, resultSeq: result.seq,
      content: [{ type: 'text', text: 'beta\n' }] }, new AbortController().signal)
    const child = scaffold.ctx.agents.get(value.sessionId)
    if (child === undefined) throw new Error('The counterfactual branch has no live Agent')
    await child.whenIdle()
    expect(parent.session.snapshotEvents()).toEqual(original)
    const own = child.session.snapshotEvents().slice(child.session.inheritedEventCount)
    expect(own.filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toEqual([])
    expect(own.some(event => event.type === 'turn/start' && event.data.continuation?.kind === 'user')).toBe(true)
    expect(own.some(event => pluginRecordOf(event)?.type === 'plugin:loom/tool-result-override')).toBe(true)
    const replacement = child.session.snapshotEvents()[value.replacementSeq]
    expect(replacement).toMatchObject({ type: 'tool/result', surfaceOp: { op: 'replace', startSeq: result.seq, endSeq: result.seq },
      data: { message: { toolCallId: result.data.message.toolCallId, content: [{ type: 'text', text: 'beta\n' }] } } })
    const surface = foldSurface(child.session.snapshotEvents(), scaffold.ctx.sessions.messageProjections)
    expect(surface.nodes).toContain(value.replacementSeq)
    expect(surface.nodes).not.toContain(result.seq)
    const continuation = requests.find(request => request.sessionId === child.id)
    expect(continuation?.messages.filter(message => message.role === 'tool').map(message => message.content))
      .toEqual([[{ type: 'text', text: 'beta\n' }]])
    expect(own.find(event => event.type === 'assistant/message')).toMatchObject({ data: { message: { content: [{ type: 'text', text: 'The tool returned beta.' }] } } })
    const sessions = [parent.session, child.session]
    for (const session of sessions) {
      await scaffold.ctx.sessions.flush(session)
      expect(await readPersistedEvents(scaffold, session.id)).toEqual(session.snapshotEvents())
    }
    const raw = sessions.map(session => normalizeWebSessionVolatiles(rawSessionLog(session), scaffold.workspaceCwd))
    const context = { sessionIds: sessions.map(session => String(session.id)), cwd: scaffold.workspaceCwd }
    if (MODE === 'refresh') {
      const replacements = refreshFixtureReplacements(sessions.map((session, index) => ({
        id: session.id, createdAt: session.header.createdAt, content: raw[index]!,
      })), expected)
      const redacted = redactSessionSnapshotIds(raw)
      expected = redactSessionSnapshotIds(stabilizeFixtureMessageIds(redacted.map((log, index) =>
        tokenizeSessionFixtureCwd(scrubSessionSnapshot(stabilizeRefreshLog(
          prepareSessionSnapshotFixtureForComparison(log), expected[index]!, replacements, context,
        ))).split(scaffold.harnessHome).join('{{harnessHome}}')), expected))
      await Promise.all(expected.map((log, index) => writeFile(
        recordedSessionFixturePath(paths[index]!, sessions[index]!.header.version), log,
      )))
    }
    expect(normalizeSessionSnapshots(raw, context)).toEqual(normalizeSessionSnapshots(expected, fixtureContext(expected[0]!)))
  } finally {
    await scaffold.close()
  }
}, 120_000)
