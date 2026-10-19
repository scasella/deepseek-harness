// Keyless Web e2e over a replayed fork-mode subagent child: Chat folds the
// turn the child inherited, the header names the owner and the child, the
// lineage switcher's token metric counts only the child's own requests, and
// the composer dock splits own from inherited work.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-subagent'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold,
  selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE_DIR = fileURLToPath(new URL('../../../snapshots/web/subagent-fork-schedule', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/subagent-fork-header', import.meta.url))
const HEADER_EXPECTED = join(SNAPSHOT_DIR, 'header.expected.md')
const DOCK_EXPECTED = join(SNAPSHOT_DIR, 'dock.expected.md')
const LINEAGE_EXPECTED = join(SNAPSHOT_DIR, 'lineage.expected.md')
const MODE = webSnapshotMode()
const PARENT_TITLE = 'Reply PARENT_READY.'
const CHILD_LABEL = 'Check child reminder refusal'

describe.skipIf(MODE === 'record')('web e2e: fork-mode subagent child', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const paths = await Promise.all(['session.v4.jsonl', 'session.1.v4.jsonl']
      .map(file => selectedSessionFixture(join(FIXTURE_DIR, file))))
    const [parentLog, childLog] = await Promise.all(paths.map(path => readFile(path, 'utf8')))
    scaffold = await launchWebScaffold({
      replayFixture: paths[0]!, replayChildFixtures: [paths[1]!], compareReplaySession: false,
    })
    const { sessionId } = await scaffold.ctx.sessionController.create({ cwd: scaffold.workspaceCwd })
    const parent = scaffold.ctx.agents.get(sessionId)
    if (parent === undefined) throw new Error('created parent has no Agent')
    const prompt = fixtureUserPrompts(parentLog!)[0]
    if (prompt === undefined) throw new Error('parent fixture has no user prompt')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const childPrompt = parseSessionLog(childLog!).findLast(event => event.type === 'user/message'
      && event.data.source.kind === 'user')
    if (childPrompt?.type !== 'user/message') throw new Error('child fixture has no user prompt')
    const activation = await scaffold.ctx.subagents.startActivation({
      provider: 'fork', label: CHILD_LABEL, delivery: 'caller',
      signal: new AbortController().signal,
      request: { parent, prompt: [...childPrompt.data.content] },
    })
    try {
      await activation.result
    } finally {
      await activation.dispose()
    }
    await scaffold.ctx.sessions.flush(parent.session)
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
    if (failures.length > 1) throw new AggregateError(failures, 'subagent-fork-header e2e cleanup failed')
  })

  it('counts only the child\'s own work in its header and dock and folds its inherited turn', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-subagent-fork-header'))
    const sessions = page.getByRole('tree', { name: 'Sessions' })
    const group = sessions.getByRole('treeitem').first()
    await group.waitFor({ timeout: 15_000 })
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    await sessions.getByRole('treeitem', { name: new RegExp(PARENT_TITLE.replace('.', '\\.'), 'u') }).click()
    await page.getByRole('button', { name: '1 subagent' }).hover()
    await page.getByRole('treeitem', { name: new RegExp(CHILD_LABEL, 'u') }).click()
    const inherited = page.getByRole('button', { name: /^Inherited from parent · turn 1/u })
    await inherited.waitFor({ timeout: 15_000 })
    expect(await inherited.getAttribute('aria-expanded')).toBe('false')
    const dock = page.locator('[data-composer-dock]')
    await expect.poll(() => dock.textContent(), { timeout: 15_000 }).toContain('inherited')
    await compareOrRefreshGolden(HEADER_EXPECTED, await captureStableAria(page, 'header', scaffold.workspaceCwd), MODE)
    await compareOrRefreshGolden(DOCK_EXPECTED, await captureStableAria(page, '[data-composer-dock]', scaffold.workspaceCwd), MODE)
    // The lineage switcher's token metric sums only the child's own requests.
    await page.getByRole('button', { name: `Switch subagent: ${CHILD_LABEL}` }).click()
    const lineage = page.getByRole('tree', { name: 'Subagent sessions' })
    await lineage.getByRole('treeitem', { name: /tok/u }).waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(
      LINEAGE_EXPECTED,
      await captureStableAria(page, '[role="tree"][aria-label="Subagent sessions"]', scaffold.workspaceCwd),
      MODE,
    )
    await page.keyboard.press('Escape')
    await lineage.waitFor({ state: 'detached', timeout: 15_000 })
  })

  it('kept the console clean and the fixture inventory closed', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['dock.expected.md', 'header.expected.md', 'lineage.expected.md'])
  })
})
