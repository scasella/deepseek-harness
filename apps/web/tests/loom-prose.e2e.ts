/** Browser guards for retained prose, non-color probability inspection, scoped family search and mobile siblings. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, type Session } from '@deepseek-ai/dsh-session'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session/types'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, parseSeedFixture, realizeSeedFixture,
  seedFork, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL('./loom.overlay.yml', import.meta.url))
const ANCHOR = fileURLToPath(new URL('../../../packages/experimental/loom-bundle/package.json', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/loom-prose/session.v4.jsonl', import.meta.url))
const SHOTS = fileURLToPath(new URL('../../../.artifacts/loom-handoff/live/s6-keyless', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/loom-prose', import.meta.url))

function ownTurn(child: Session, text: string): void {
  child.append('turn/start', { turn: 2 })
  child.append('step/start', { turn: 2, step: 1 })
  child.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  child.append('assistant/message', { turn: 2, step: 1, stream: [], message: createAssistantMessage({
    content: [{ type: 'text', text: 'A coastal continuation.' }], source: { provider: 'fixture', model: 'fixture' },
  }) }, { surfaceOp: 'append' })
  child.append('step/end', { turn: 2, step: 1 })
  child.append('session/title', { title: text.endsWith('A') ? 'Northern path' : 'Southern path', messageSeqs: [], source: { kind: 'user' } })
  child.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
}

describe.skipIf(MODE === 'record')('web e2e: Loom prose and mobile families', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  const browserErrors: string[] = []
  beforeAll(async () => {
    await mkdir(EXPECTED, { recursive: true })
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: [ANCHOR] })
    const fixtureText = await readFile(FIXTURE, 'utf8')
    const cut = parseSeedFixture(fixtureText).events.find(event => event.type === 'turn/end')
    if (cut === undefined) throw new Error('Prose fixture has no completed turn')
    const createdAt = Date.now() - 60_000
    // Auxiliary prose records are legal after turn/end; preserve their exact order instead of fabricating another turn.
    const root = SessionId('prose-root')
    const decoded = parseSeedFixture(realizeSeedFixture(scaffold, fixtureText, root))
    const handle = await scaffold.ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id: root, createdAt, cwd: scaffold.workspaceCwd,
      isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
    }, { inheritedEventCount: SessionLogOffset(0) })
    try { await handle.append(decoded.events) } finally { await handle.close() }
    await seedFork(scaffold, root, 'prose-coast-a', {
      atSeq: cut.seq, createdAt: createdAt + 1, continueWith: (child) => { ownTurn(child, 'Own coastal note A') },
    })
    await seedFork(scaffold, root, 'prose-coast-b', {
      atSeq: cut.seq, createdAt: createdAt + 2, continueWith: (child) => { ownTurn(child, 'Own coastal note B') },
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    page.on('pageerror', (error) => { browserErrors.push(String(error)) })
    page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()) })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('tree', { name: 'Sessions' }).getByRole('treeitem').first().click()
    await page.locator('[data-row-key="session:prose-root"]').click()
  }, 120_000)
  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  async function shots(name: string, widths: readonly number[] = [1680, 390]): Promise<void> {
    await mkdir(SHOTS, { recursive: true })
    const viewport = page.viewportSize()
    for (const width of widths) for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1050 })
      await page.emulateMedia({ colorScheme })
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { resolve() }))))
      if (width === 390 && name === 'multiverse') await expect.poll(async () =>
        (await page.getByRole('region', { name: 'Multiverse', exact: true }).boundingBox())?.width ?? 0).toBeGreaterThan(300)
      await page.screenshot({ path: join(SHOTS, `${name}-${width}-${colorScheme}.png`), animations: 'disabled' })
    }
    await page.emulateMedia({ colorScheme: 'light' })
    if (viewport !== null) await page.setViewportSize(viewport)
  }

  it('opens persisted prose and an equivalent written token probability', async () => {
    await page.getByRole('tab', { name: 'Loom', exact: true }).click()
    await page.getByRole('tab', { name: 'Weave', exact: true }).click()
    const prose = page.getByRole('region', { name: 'Weave prose', exact: true })
    await prose.getByRole('textbox').waitFor()
    expect(await prose.getByRole('textbox').inputValue()).toBe('The sea waited.')
    await compareOrRefreshGolden(join(EXPECTED, 'document.expected.md'), await captureStableAria(page, 'section[aria-label="Weave prose"]', scaffold.workspaceCwd), MODE)
    await shots('document')
    await prose.getByRole('button', { name: /waited.*probability/ }).click()
    await page.getByRole('dialog', { name: 'Token probabilities' }).waitFor()
    await compareOrRefreshGolden(join(EXPECTED, 'probability.expected.md'), await captureStableAria(page, '[role="dialog"][aria-label="Token probabilities"]', scaffold.workspaceCwd), MODE)
    await shots('probability')
    await page.getByRole('button', { name: 'Close probabilities' }).click()
    await prose.getByRole('button', { name: 'Show alternatives' }).click()
    await prose.getByRole('button', { name: 'Choose continuation' }).first().waitFor()
    await compareOrRefreshGolden(join(EXPECTED, 'alternatives.expected.md'), await captureStableAria(page, 'section[aria-label="Weave prose"]', scaffold.workspaceCwd), MODE)
  })

  it('downloads the selected path with its curation record and fits a phone viewport', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    const prose = page.getByRole('region', { name: 'Weave prose', exact: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await compareOrRefreshGolden(join(EXPECTED, 'phone.expected.md'), await captureStableAria(page, 'section[aria-label="Weave prose"]', scaffold.workspaceCwd), MODE)
    await prose.getByRole('button', { name: 'Weave', exact: true }).click({ trial: true })
    await shots('phone-controls', [390])
    await prose.getByRole('button', { name: 'Export path' }).click()
    const dialog = page.getByRole('dialog', { name: 'Export path' })
    await dialog.getByRole('combobox', { name: 'Format', exact: true }).selectOption('json')
    await compareOrRefreshGolden(join(EXPECTED, 'export.expected.md'), await captureStableAria(page, '[role="dialog"][aria-label="Export path"]', scaffold.workspaceCwd), MODE)
    await shots('export')
    const downloaded = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Download', exact: true }).click()
    const download = await downloaded
    const path = await download.path()
    if (path === null) throw new Error('The prose download was not saved')
    const content = await readFile(path, 'utf8')
    expect(content).toContain('waited.')
    expect(content).toContain('\"curationBits\": 1')
    await dialog.getByRole('button', { name: 'Close export' }).click()
    await page.setViewportSize({ width: 1680, height: 1050 })
  })

  it('searches own family history and opens the touch sibling chooser', async () => {
    const reopen = page.getByRole('button', { name: 'Open sidebar', exact: true })
    if (await reopen.isVisible()) await reopen.click()
    await page.getByRole('button', { name: 'Multiverse', exact: true }).click()
    const multiverse = page.getByRole('region', { name: 'Multiverse', exact: true })
    await multiverse.getByRole('textbox', { name: 'Search family titles and messages' }).fill('coastal')
    await multiverse.getByText('Own coastal note A', { exact: false }).waitFor()
    await compareOrRefreshGolden(join(EXPECTED, 'multiverse.expected.md'), await captureStableAria(page, 'section[aria-label="Multiverse"]', scaffold.workspaceCwd), MODE)
    await shots('multiverse')
    await multiverse.getByRole('combobox', { name: 'Message scope', exact: true }).selectOption('inherited')
    await multiverse.getByText('No matching fork families', { exact: true }).waitFor()
    if (await reopen.isVisible()) await reopen.click()
    const child = page.locator('[data-row-key="session:prose-coast-a"]')
    await child.getByText('Northern path · Fork prose-coast-a', { exact: true }).click()
    try { await page.getByRole('tab', { name: 'Chat', exact: true }).waitFor() } catch (error: unknown) {
      await writeFile(join(SHOTS, 'navigation-failure.aria.txt'), await page.locator('body').ariaSnapshot())
      await writeFile(join(SHOTS, 'navigation-failure.json'), JSON.stringify({ errors: browserErrors, row: await child.evaluate(element => element.outerHTML) }, null, 2))
      throw error
    }
    await page.setViewportSize({ width: 390, height: 844 })
    const chip = page.getByRole('button', { name: /Variant 1 of 2.*Switch variant/ })
    try { await chip.click() } catch (error: unknown) {
      await writeFile(join(SHOTS, 'sibling-failure.aria.txt'), await page.locator('body').ariaSnapshot())
      throw error
    }
    const sheet = page.getByRole('dialog', { name: /Variants/ })
    await sheet.waitFor()
    const bounds = await sheet.boundingBox()
    expect(bounds?.width).toBe(390)
    expect(bounds?.y).toBeGreaterThan(0)
    await compareOrRefreshGolden(join(EXPECTED, 'sibling-sheet.expected.md'), await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)
    await shots('sibling-sheet', [390])
    await page.keyboard.press('Escape')
    expect(await sheet.count()).toBe(0)
    await page.setViewportSize({ width: 1680, height: 1050 })
  })
})
