// Keyless assembled-browser coverage for the opt-in Loom bundle over a seeded
// fork family: the folded inherited span and the fork band at the cut, the
// header crumbs and variant chip, the Loom tab's family tree and its keys, the
// reading pane with what the model saw, and the tree rows in the shortcut reference.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  parseSeedFixture, seedForkFamily, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/loom-tab', import.meta.url))
const FLOW_EXPECTED = join(SNAPSHOT_DIR, 'flow.expected.md')
const HEADER_EXPECTED = join(SNAPSHOT_DIR, 'header.expected.md')
const TREE_EXPECTED = join(SNAPSHOT_DIR, 'tree.expected.md')
const TREE_KEYS_EXPECTED = join(SNAPSHOT_DIR, 'tree-keys.expected.md')
const READER_EXPECTED = join(SNAPSHOT_DIR, 'reader.expected.md')
const SHORTCUTS_EXPECTED = join(SNAPSHOT_DIR, 'shortcuts.expected.md')
const NARROW_EXPECTED = join(SNAPSHOT_DIR, 'narrow-band.expected.md')
const OVERLAY = fileURLToPath(new URL('./loom.overlay.yml', import.meta.url))
const LOOM_PATCH = fileURLToPath(new URL('../../../packages/experimental/loom-bundle/cordis.patch.yml', import.meta.url))
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/experimental/loom-bundle/package.json', import.meta.url)),
]
const MODE = webSnapshotMode()
const ROOT_ID = 'loom-tab-root'
const BRANCH_A = 'loom-tab-a'
const BRANCH_B = 'loom-tab-b'
const MARKER_A = 'LOOM_TAB_A'

function profileEntries(path: string): unknown[] {
  const parsed = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error(`profile layer at ${path} must be a list`)
  return parsed
}

/** Append one completed own turn after a fork seed: the prompt and one assistant step with reasoning. */
function appendOwnTurn(child: Session, turn: number): void {
  child.append('turn/start', { turn })
  child.append('step/start', { turn, step: 1 })
  child.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `${MARKER_A} Take the other approach from here.` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  child.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [
        { type: 'reasoning', text: `${MARKER_A} Weigh the inherited answer first.` },
        { type: 'text', text: `${MARKER_A} This branch continues from the inherited answer.` },
      ],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
    usage: { inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 6_000, reasoningTokens: 120, totalTokens: 7_500 },
  }, { surfaceOp: 'append' })
  child.append('step/end', { turn, step: 1 })
  child.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Read the tree level of the focused element, or null when focus is outside a tree row. */
async function focusedLevel(page: Page): Promise<string | null> {
  return await page.evaluate(() => document.activeElement?.getAttribute('aria-level') ?? null)
}

describe('Loom overlay', () => {
  it('matches the shipped Loom bundle', () => {
    expect(profileEntries(OVERLAY)).toEqual(profileEntries(LOOM_PATCH))
  })
})

describe.skipIf(MODE === 'record')('web e2e: Loom fork band and tab', () => {
  const rootFixture = createChatScrollFixture({ markerPrefix: 'LOOMTAB', title: 'Loom family', turns: 2 })
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let sessions: Locator

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: INSTALL_ANCHORS })
    const events = parseSeedFixture(rootFixture.log).events
    const cut = events.find(event => event.type === 'turn/end' && event.data.turn === 1)
    if (cut === undefined) throw new Error('Loom root fixture lacks turn/end for turn 1')
    const rootCreatedAt = Date.now() - 60_000
    await seedForkFamily(scaffold, { fixtureText: rootFixture.log, id: ROOT_ID, agentPreset: 'standard', createdAt: rootCreatedAt }, [
      { id: BRANCH_A, atSeq: cut.seq, createdAt: rootCreatedAt + 10_000, continueWith: (child) => { appendOwnTurn(child, 2) } },
      { id: BRANCH_B, atSeq: cut.seq, createdAt: rootCreatedAt + 20_000 },
    ])
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    // The shortcut reference opens with the Mac chord on every host.
    await page.addInitScript(() => { Object.defineProperty(navigator, 'platform', { value: 'MacIntel' }) })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    sessions = page.getByRole('tree', { name: 'Sessions' })
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'loom-tab e2e cleanup failed')
  })

  it('folds the inherited span under the band and names the variant in the header', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-loom-band'))
    const groupRow = sessions.getByRole('treeitem').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    await expect.poll(() => sessions.getByRole('treeitem').count(), { timeout: 15_000 }).toBe(4)
    // Rows sort by recency: branch B, branch A, then the root. Reading the root first lists its durable title.
    await sessions.getByRole('treeitem').nth(3).click()
    await page.getByText(rootFixture.markers.user(2), { exact: false }).last().waitFor({ timeout: 15_000 })
    expect(await page.locator('[data-loom-fork-band]').count()).toBe(0)
    expect(await page.getByRole('button', { name: /Inherited from parent/u }).count()).toBe(0)
    await expect.poll(() => sessions.getByRole('treeitem').nth(3).textContent(), { timeout: 15_000 }).toContain('Loom family')

    await sessions.getByRole('treeitem').nth(2).click()
    await page.getByText(`${MARKER_A} This branch continues`, { exact: false }).last().waitFor({ timeout: 15_000 })
    const band = page.locator('[data-loom-fork-band]')
    await band.waitFor({ timeout: 15_000 })
    await expect.poll(() => band.getByRole('button', { name: /Variant 2 of 2/u }).count(), { timeout: 15_000 }).toBe(1)
    const inherited = page.getByRole('button', { name: 'Inherited from parent · turn 1 · 1 step' })
    expect(await inherited.getAttribute('aria-expanded')).toBe('false')
    expect(await page.getByText(rootFixture.markers.user(1), { exact: false }).isVisible()).toBe(false)
    await compareOrRefreshGolden(FLOW_EXPECTED, await captureStableAria(page, '[data-chat-flow]', scaffold.workspaceCwd), MODE)
    const chip = page.getByRole('button', { name: 'Variant 1 of 2, after turn 1. Switch variant' })
    await chip.waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(HEADER_EXPECTED, await captureStableAria(page, 'header', scaffold.workspaceCwd), MODE)

    await inherited.click()
    expect(await inherited.getAttribute('aria-expanded')).toBe('true')
    await page.getByText(rootFixture.markers.user(1), { exact: false }).waitFor({ timeout: 15_000 })
    await inherited.click()
    expect(await inherited.getAttribute('aria-expanded')).toBe('false')

    await chip.click()
    const menu = page.getByRole('menu')
    await menu.waitFor({ timeout: 15_000 })
    expect(await menu.getByRole('menuitem').allTextContents()).toEqual(['1. Loom family', '2. Loom family'])
    await page.keyboard.press('Escape')
    await band.getByRole('button', { name: 'Variant 2 of 2: Loom family' }).click()
    await expect.poll(
      () => page.getByRole('button', { name: 'Variant 2 of 2, after turn 1. Switch variant' }).count(),
      { timeout: 15_000 },
    ).toBe(1)
    await page.locator('[data-loom-fork-band]').getByRole('button', { name: 'Variant 1 of 2: Loom family' }).click()
    await chip.waitFor({ timeout: 15_000 })
    await page.getByText(`${MARKER_A} This branch continues`, { exact: false }).last().waitFor({ timeout: 15_000 })
  })

  it('outlines the family in the Loom tab and moves through it with the tree keys', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-loom-tree'))
    await page.getByRole('tab', { name: 'Loom' }).click()
    const tree = page.getByRole('tree', { name: 'Fork family' })
    await tree.waitFor({ timeout: 15_000 })
    await expect.poll(() => tree.getByRole('treeitem').count(), { timeout: 15_000 }).toBe(4)
    await compareOrRefreshGolden(TREE_EXPECTED, await captureStableAria(page, '[data-loom-view] [role="tree"]', scaffold.workspaceCwd), MODE)
    const reader = page.getByRole('region', { name: 'Selected path' })
    const readId = (): Promise<string | null> => reader.locator('[data-loom-reader]').getAttribute('data-loom-reader')

    await tree.locator('[role="treeitem"][aria-selected="true"]').focus()
    expect(await focusedLevel(page)).toBe('3')
    await page.keyboard.press('Home')
    expect(await focusedLevel(page)).toBe('1')
    await page.keyboard.press('ArrowDown')
    expect(await focusedLevel(page)).toBe('2')
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => tree.getByRole('treeitem').count(), { timeout: 15_000 }).toBe(2)
    await compareOrRefreshGolden(TREE_KEYS_EXPECTED, await captureStableAria(page, '[data-loom-view] [role="tree"]', scaffold.workspaceCwd), MODE)
    await page.keyboard.press('ArrowLeft')
    expect(await focusedLevel(page)).toBe('1')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => tree.getByRole('treeitem').count(), { timeout: 15_000 }).toBe(4)
    await page.keyboard.press('ArrowRight')
    expect(await focusedLevel(page)).toBe('3')
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await expect.poll(readId, { timeout: 15_000 }).toBe(BRANCH_B)

    await page.keyboard.press('Home')
    await page.keyboard.press('Enter')
    // Forks inherit the root's durable title, so the root reads apart by having no inherited span.
    await expect.poll(readId, { timeout: 15_000 }).toBe(ROOT_ID)
    expect(await reader.getByRole('button', { name: /Inherited from parent/u }).count()).toBe(0)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press(' ')
    await reader.getByRole('button', { name: /Inherited from parent/u }).waitFor({ timeout: 15_000 })
    expect(await readId()).toBe(BRANCH_A)
  })

  it('reads the selected fork with its reasoning and what the model saw', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-loom-reader'))
    const reader = page.getByRole('region', { name: 'Selected path' })
    await reader.getByText(`${MARKER_A} This branch continues`, { exact: false }).waitFor({ timeout: 15_000 })
    await reader.getByText('120 tokens this turn').waitFor({ timeout: 15_000 })
    await reader.getByRole('button', { name: 'What the model saw for this turn' }).click()
    await reader.getByText('4 messages, 3 inherited').waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(READER_EXPECTED, await captureStableAria(page, '[data-loom-reader]', scaffold.workspaceCwd), MODE)
  })

  it('lists the tree keys in the shortcut reference', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-loom-shortcuts'))
    await page.keyboard.press('Meta+Slash')
    const reference = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true })
    await reference.waitFor({ timeout: 15_000 })
    await reference.getByRole('region', { name: 'Trees and outlines', exact: true }).waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(
      SHORTCUTS_EXPECTED,
      await captureStableAria(page, '[role="dialog"] section[aria-label="Trees and outlines"]', scaffold.workspaceCwd),
      MODE,
    )
    await page.keyboard.press('Escape')
    await reference.waitFor({ state: 'detached', timeout: 15_000 })
  })

  it('narrows the band at phone width and hides the header chip', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-loom-narrow'))
    const original = page.viewportSize()
    await page.setViewportSize({ width: 390, height: 844 })
    try {
      await page.getByRole('tab', { name: 'Chat' }).click()
      const band = page.locator('[data-loom-fork-band]')
      await band.waitFor({ timeout: 15_000 })
      const strip = band.getByRole('group', { name: 'Variants after turn 1' })
      await strip.getByRole('button', { name: 'Variant 1 of 2: Loom family' }).waitFor({ timeout: 15_000 })
      // The label stacks the lead, the parent title, and the cut on three lines.
      const labelLines = await band.getByRole('group', { name: 'Branched from Loom family after turn 1' }).evaluate(
        element => new Set([...element.children].filter(child => child.tagName === 'SPAN')
          .map(child => Math.round(child.getBoundingClientRect().top))).size,
      )
      const chipHeights = await strip.getByRole('button').evaluateAll(chips => chips.map(chip => Math.round(chip.getBoundingClientRect().height)))
      const currentInView = await strip.evaluate((group) => {
        const current = group.querySelector('[aria-current="true"]')
        const scroller = current?.parentElement
        if (current == null || scroller == null) return false
        const chip = current.getBoundingClientRect()
        const row = scroller.getBoundingClientRect()
        return chip.left >= row.left - 0.5 && chip.right <= row.right + 0.5
      })
      const headerChips = await page.getByRole('button', { name: /Switch variant/u }).count()
      const pageScrolls = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
      expect(labelLines).toBe(3)
      expect(chipHeights).toEqual([32, 32])
      expect(currentInView).toBe(true)
      expect(headerChips).toBe(0)
      expect(pageScrolls).toBe(false)
      const facts = [
        `label lines: ${String(labelLines)}`,
        `chip heights: ${chipHeights.join(', ')}`,
        `current chip in view: ${String(currentInView)}`,
        `header variant chips: ${String(headerChips)}`,
        `page scrolls sideways: ${String(pageScrolls)}`,
      ]
      await compareOrRefreshGolden(
        NARROW_EXPECTED,
        [
          '# Loom fork band at 390px',
          '',
          ...facts,
          '',
          '## Band',
          '',
          await captureStableAria(page, '[data-loom-fork-band]', scaffold.workspaceCwd),
          '',
          '## Header',
          '',
          await captureStableAria(page, 'header', scaffold.workspaceCwd),
        ].join('\n'),
        MODE,
      )
    } finally {
      if (original !== null) await page.setViewportSize(original)
    }
  })

  it('kept the console clean and the fixture inventory closed', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'flow.expected.md', 'header.expected.md', 'narrow-band.expected.md', 'reader.expected.md', 'shortcuts.expected.md',
      'tree-keys.expected.md', 'tree.expected.md',
    ])
  })
})
