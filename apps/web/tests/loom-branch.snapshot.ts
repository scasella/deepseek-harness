/** Loom regenerate and steer sets over a replayed Web Session: four fork children through the real agent loop. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { LoomBranchRequestId } from '@deepseek-ai/dsh-experimental-loom'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'
import { pluginRecordOf, type Session } from '@deepseek-ai/dsh-session'
import {
  fixtureContext, normalizeSessionSnapshots, normalizedSystemPrompts, normalizedToolSchemas,
  formatSystemPromptSnapshot, parseToolSchemasSnapshot, redactSessionSnapshotIds, refreshFixtureReplacements,
  scrubSessionSnapshot, stabilizeFixtureMessageIds, stabilizeRefreshLog, tokenizeSessionFixtureCwd,
} from '@deepseek-ai/dsh-session-snapshot'
import {
  fixtureUserPrompts, launchWebScaffold, normalizeWebSessionVolatiles, rawSessionLog, readPersistedEvents,
  recordedSessionFixturePath, selectedSessionFixture, webSnapshotMode,
} from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/loom-branch', import.meta.url))
const PIN = join(DIR, '../fresh-round-trip')
const OVERLAY = fileURLToPath(new URL('./loom.overlay.yml', import.meta.url))
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/experimental/loom-bundle/package.json', import.meta.url)),
]
const MODE = webSnapshotMode()
const REGENERATE_REQUEST = brandString<LoomBranchRequestId>('loom-snapshot-regenerate')
const STEER_REQUEST = brandString<LoomBranchRequestId>('loom-snapshot-steer')

/** The `plugin:loom/branch` record of a child and the user prompts it ran itself, with their request ids. */
function branchFacts(child: Session) {
  const events = child.snapshotEvents()
  const [record] = events.flatMap((event) => {
    const plugin = pluginRecordOf(event)
    return plugin?.type === 'plugin:loom/branch' ? [plugin.data] : []
  })
  if (record === undefined) throw new Error(`child ${child.id} has no plugin:loom/branch record`)
  const own = events.slice(child.inheritedEventCount).flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user' ? [event.data] : [])
  return {
    record,
    prompts: own.map(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')),
    rpcIds: own.map(message => 'rpcId' in message.source ? String(message.source.rpcId) : ''),
  }
}

it.skipIf(MODE === 'record')('replays a regenerate set and a steer set as four fork children through the real loop', async () => {
  const paths = await Promise.all(['session.v4.jsonl', 'session.1.v4.jsonl', 'session.2.v4.jsonl', 'session.3.v4.jsonl', 'session.4.v4.jsonl']
    .map(file => selectedSessionFixture(join(DIR, file))))
  let expected = await Promise.all(paths.map(path => readFile(path, 'utf8')))
  // Children claim their recorded scripts in creation order. They share one writable folder, so the
  // runner forks them one at a time and that order is the request order.
  const scaffold = await launchWebScaffold({
    extraOverlayPath: OVERLAY,
    extraInstallAnchors: INSTALL_ANCHORS,
    replayFixture: paths[0]!,
    replayChildFixtures: paths.slice(1),
    compareReplaySession: false,
  })
  try {
    const sessions: Session[] = []
    scaffold.ctx.on('session/created', (session) => { sessions.push(session) })
    const { sessionId } = await scaffold.ctx.sessionController.create({ cwd: scaffold.workspaceCwd })
    const parent = scaffold.ctx.agents.get(sessionId)
    if (parent === undefined) throw new Error('created parent has no Agent')
    const prompts = fixtureUserPrompts(expected[0]!)
    expect(prompts).toHaveLength(3)
    for (const prompt of prompts) {
      parent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
      await parent.whenIdle()
    }
    await scaffold.ctx.sessions.flush(parent.session)
    const parentEvents = parent.session.snapshotEvents()
    const turnEnd = (turn: number): number => {
      const end = parentEvents.find(event => event.type === 'turn/end' && event.data.turn === turn)
      if (end === undefined) throw new Error(`parent lacks turn/end for turn ${String(turn)}`)
      return end.seq
    }

    // Regenerate turn 3 twice, then steer after turn 1 with the two lines the recorded children were sent.
    // A child fixture lists its inherited prompts first, so its own prompt is the last one.
    const lastPromptOf = (fixture: string): string => {
      const line = fixtureUserPrompts(fixture).at(-1)
      if (line === undefined) throw new Error('child fixture has no user prompt')
      return line
    }
    const steerLines = [lastPromptOf(expected[3]!), lastPromptOf(expected[4]!)]
    expect(new Set([...prompts, ...steerLines]).size).toBe(5)
    expect([lastPromptOf(expected[1]!), lastPromptOf(expected[2]!)]).toEqual([prompts[2], prompts[2]])
    const regenerate = await scaffold.ctx.loom.branch({ kind: 'regenerate', sessionId, requestId: REGENERATE_REQUEST, turn: 3, count: 2 })
    const steer = await scaffold.ctx.loom.branch({ kind: 'steer', sessionId, requestId: STEER_REQUEST, afterTurn: 1, lines: steerLines })
    expect(regenerate.children.map(child => child.index)).toEqual([0, 1])
    expect(steer.children.map(child => child.index)).toEqual([0, 1])
    await vi.waitFor(() => { expect(sessions).toHaveLength(5) }, { timeout: 30_000 })
    const children = sessions.slice(1)
    for (const child of children) await scaffold.ctx.agents.get(child.id)?.whenIdle()
    for (const session of sessions) await scaffold.ctx.sessions.flush(session)
    for (const child of children) {
      expect(child.header).toMatchObject({ parentSession: parent.id, isSeeded: true, agentPreset: 'standard' })
      expect(child.inheritedEventCount).toBeGreaterThan(0)
    }

    // Branching leaves the parent's log alone.
    expect(parent.session.snapshotEvents()).toEqual(parentEvents)

    // Each set is cut where its request names: before the regenerated turn, and after turn 1 although turns 2 and 3 exist.
    const facts = children.map(branchFacts)
    expect(facts.map(({ record }) => record)).toMatchObject([
      { kind: 'regenerate', index: 0, atSeq: turnEnd(2), setId: regenerate.setId },
      { kind: 'regenerate', index: 1, atSeq: turnEnd(2), setId: regenerate.setId },
      { kind: 'steer', index: 0, atSeq: turnEnd(1), setId: steer.setId },
      { kind: 'steer', index: 1, atSeq: turnEnd(1), setId: steer.setId },
    ])
    expect(regenerate.setId).not.toBe(steer.setId)
    expect(children[0]!.inheritedEventCount).toBe(children[1]!.inheritedEventCount)
    expect(children[2]!.inheritedEventCount).toBe(children[3]!.inheritedEventCount)
    expect(children[0]!.inheritedEventCount).toBeGreaterThan(children[2]!.inheritedEventCount)
    // Regenerate sends the opening prompt again; steer sends each line; the request id and child index name the prompt.
    expect(facts.map(({ prompts: own }) => own)).toEqual([[prompts[2]], [prompts[2]], [steerLines[0]], [steerLines[1]]])
    expect(facts.map(({ rpcIds }) => rpcIds)).toEqual([
      [`${REGENERATE_REQUEST}/0`], [`${REGENERATE_REQUEST}/1`], [`${STEER_REQUEST}/0`], [`${STEER_REQUEST}/1`],
    ])

    for (const session of sessions) {
      expect(await readPersistedEvents(scaffold, session.id)).toEqual(session.snapshotEvents())
    }
    const raw = sessions.map(session => normalizeWebSessionVolatiles(rawSessionLog(session), scaffold.workspaceCwd))
    const context = { sessionIds: sessions.map(session => String(session.id)), cwd: scaffold.workspaceCwd }
    const schemas = parseToolSchemasSnapshot(await readFile(join(PIN, 'tool-schemas.expected.json'), 'utf8'))
    const promptPin = await readFile(join(PIN, 'system-prompt.expected.md'), 'utf8')
    for (const log of raw) {
      const headers = normalizedToolSchemas(log, context)
      expect(headers.length).toBeGreaterThan(0)
      for (const tools of headers) expect(tools).toEqual(schemas.initial)
      for (const prompt of normalizedSystemPrompts(log, context)) {
        expect(formatSystemPromptSnapshot(prompt.split(REPO_ROOT).join('{{sourceRoot}}')
          .split(scaffold.baseUrl).join('{{webUrl}}'))).toBe(promptPin)
      }
    }

    if (MODE === 'refresh') {
      const replacements = refreshFixtureReplacements(raw.map((content, index) => ({
        id: sessions[index]!.id, createdAt: sessions[index]!.header.createdAt, content,
      })), expected)
      expected = redactSessionSnapshotIds(stabilizeFixtureMessageIds(raw.map((log, index) =>
        tokenizeSessionFixtureCwd(scrubSessionSnapshot(stabilizeRefreshLog(
          prepareSessionSnapshotFixtureForComparison(log), expected[index]!, replacements, context,
        ))).split(scaffold.harnessHome).join('{{harnessHome}}')), expected))
      await Promise.all(expected.map((log, index) => writeFile(
        recordedSessionFixturePath(paths[index]!, sessions[index]!.header.version), log,
      )))
    }
    expect(normalizeSessionSnapshots(raw, context))
      .toEqual(normalizeSessionSnapshots(expected, fixtureContext(expected[0]!)))
  } finally {
    await scaffold.close()
  }
}, 120_000)
