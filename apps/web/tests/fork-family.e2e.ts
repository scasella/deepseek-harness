// Keyless Web e2e over a fork family seeded without model calls: the footer
// splits a fork's own work from its inherited prefix, the Host lists the fork's
// lineage, and the seeded log starts as the one the session.fork RPC stores.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  parseSeedFixture, seedForkFamily, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/fork-family', import.meta.url))
const DOCK_EXPECTED = join(SNAPSHOT_DIR, 'dock.expected.md')
const MODE = webSnapshotMode()
const ROOT_ID = 'fork-family-root'
const BRANCH_A = 'fork-family-a'
const BRANCH_B = 'fork-family-b'
const MARKER_A = 'FORK_FAMILY_A'

/**
 * Append one completed own turn after a fork seed: the user prompt and a single
 * assistant step carrying the given usage.
 */
function appendOwnTurn(child: Session, turn: number, marker: string, usage: TokenUsage): void {
  child.append('turn/start', { turn })
  child.append('step/start', { turn, step: 1 })
  child.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `${marker} Take the other approach from here.` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  child.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: `${marker} This branch continues from the inherited answer.` }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
    usage,
  }, { surfaceOp: 'append' })
  child.append('step/end', { turn, step: 1 })
  child.append('turn/end', { turn, reason: { kind: 'completed' } })
}

async function readStored(scaffold: WebScaffold, id: SessionId): Promise<{
  readonly header: SessionHeader
  readonly inheritedEventCount: number
  readonly events: readonly SessionEvent[]
}> {
  const handle = await scaffold.ctx.sessionPersistence.open(id, 'read')
  try {
    return { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events: (await handle.read()).events }
  } finally {
    await handle.close()
  }
}

function turnEndSeq(events: readonly SessionEvent[], turn: number): number {
  const event = events.find(candidate => candidate.type === 'turn/end' && candidate.data.turn === turn)
  if (event === undefined) throw new Error(`fork-family root lacks turn/end for turn ${String(turn)}`)
  return event.seq
}

describe.skipIf(MODE === 'record')('web e2e: seeded fork family', () => {
  const rootFixture = createChatScrollFixture({ markerPrefix: 'FORKFAM', title: 'Fork family', turns: 2 })
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let cutSeq: number
  let createdA: number

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    cutSeq = turnEndSeq(parseSeedFixture(rootFixture.log).events, 1)
    const rootCreatedAt = Date.now() - 60_000
    // Distinct creation times keep sibling recency, and so sidebar order, deterministic.
    createdA = rootCreatedAt + 10_000
    await seedForkFamily(scaffold, { fixtureText: rootFixture.log, id: ROOT_ID, agentPreset: 'standard', createdAt: rootCreatedAt }, [
      {
        id: BRANCH_A,
        atSeq: cutSeq,
        createdAt: createdA,
        continueWith: (child) => {
          appendOwnTurn(child, 2, MARKER_A, { inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 6_000 })
        },
      },
      { id: BRANCH_B, atSeq: cutSeq, createdAt: rootCreatedAt + 20_000 },
    ])
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'fork-family e2e cleanup failed')
  })

  it('splits the opened fork\'s footer into own and inherited work', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-fork-family-dock'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    await expect.poll(() => page.locator('[role="treeitem"]').count(), { timeout: 15_000 }).toBe(4)
    // Rows sort by recency: branch B, branch A, then the root.
    await page.locator('[role="treeitem"]').nth(2).click()
    await page.getByText(`${MARKER_A} This branch continues`, { exact: false }).last().waitFor({ timeout: 15_000 })
    const dock = page.locator('[data-composer-dock]')
    await expect.poll(() => dock.textContent(), { timeout: 15_000 }).toContain('inherited')
    await compareOrRefreshGolden(DOCK_EXPECTED, await captureStableAria(page, '[data-composer-dock]', scaffold.workspaceCwd), MODE)
  })

  it('lists the opened fork\'s parent, cut, and last inherited turn', async () => {
    const { items } = await scaffold.ctx.sessionController.list({}, new AbortController().signal)
    const row = items.find(item => item.sessionId === SessionId(BRANCH_A))
    expect(row?.projections?.values.forkLineage).toEqual({
      parentSession: SessionId(ROOT_ID), cutSeq: SessionSeq(cutSeq), cutTurn: 1, createdAt: createdA,
    })
  })

  it('stores the lineage header, inherited prefix, and cut marker the session.fork RPC stores', async () => {
    const response = await scaffold.hostFetch('/api/session/fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'fork-family-rpc', method: 'session/fork',
        payload: { args: { request: { sessionId: ROOT_ID, atSeq: cutSeq } } },
      }),
    })
    expect(response.ok).toBe(true)
    const body = await response.json() as { result: { ok: boolean; value?: { sessionId: string } } }
    expect(body.result.ok).toBe(true)
    const forked = scaffold.ctx.sessions.get(SessionId(body.result.value!.sessionId))
    if (forked === undefined) throw new Error('session.fork did not publish a live child')
    await scaffold.ctx.sessions.flush(forked)

    const seeded = await readStored(scaffold, SessionId(BRANCH_B))
    const stored = await readStored(scaffold, forked.id)
    expect(seeded.inheritedEventCount).toBe(stored.inheritedEventCount)
    // The RPC child continues with the Host's activation events; the seed stops at its marker.
    expect(seeded.events).toEqual(stored.events.slice(0, stored.inheritedEventCount + 1))
    const { id: _seededId, createdAt: _seededAt, ...seededHeader } = seeded.header
    const { id: _storedId, createdAt: _storedAt, ...storedHeader } = stored.header
    expect(seededHeader).toEqual(storedHeader)

    // Opening the seeded A closed its replayed log with a resume seed marker and then appended the
    // RPC child's activation events, so they follow its own turn instead of its fork marker.
    // A is live because the dock case opened it in the browser.
    const openedA = scaffold.ctx.sessions.get(SessionId(BRANCH_A))
    if (openedA === undefined) throw new Error('the opened fork is not live')
    await scaffold.ctx.sessions.flush(openedA)
    const seededA = await readStored(scaffold, SessionId(BRANCH_A))
    const typedData = (events: readonly SessionEvent[]) => events.map(({ type, data }) => ({ type, data }))
    const activation = typedData(stored.events.slice(stored.inheritedEventCount + 1))
    expect(activation.map(event => event.type)).toEqual(['permission/preset', 'sandbox/mode', 'approval/policy'])
    expect(typedData(seededA.events.slice(-activation.length))).toEqual(activation)
    expect(seededA.events.slice(seededA.inheritedEventCount + 1, -activation.length).map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end', 'session/end-seed',
    ])
  })

  it('kept the console clean and the fixture inventory closed', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['dock.expected.md'])
  })
})
