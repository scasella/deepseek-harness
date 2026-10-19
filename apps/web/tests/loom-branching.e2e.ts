// Keyless assembled-browser coverage for Loom branching over a seeded fork
// family: the Regenerate panel and a regenerate ×2 of a fork's first own turn
// that joins the fork's variants, the running strip while one child runs and
// the next waits for the shared folder, Edit and branch into a further
// variant, private marks, the Branch ×N form with a sampled line and its
// tallies, the pager's own row and the marks' names at 390px on a touch device
// without hover, the Chinese copy, and a route chosen for one branch only.
//
// Replay binding: the seeded family never calls the model. Loom children that
// share a writable folder run one at a time, so the first child claims the
// primary script, a hang that holds it running while the second is queued;
// each later child claims one copy of a recorded single-call fixture in
// creation order.
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  parseSeedFixture, seedForkFamily, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { appendOpenedTurn, CHILD_REPLY, seedFixtureText, writeReplayInputs } from './loom-support.ts'
import { newEnglishPage, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/loom-branching', import.meta.url))
const REGENERATE_EXPECTED = join(SNAPSHOT_DIR, 'regenerate-panel.expected.md')
const STRIP_EXPECTED = join(SNAPSHOT_DIR, 'strip.expected.md')
const EDIT_EXPECTED = join(SNAPSHOT_DIR, 'edit-panel.expected.md')
const FLOW_EXPECTED = join(SNAPSHOT_DIR, 'flow.expected.md')
const FORM_EXPECTED = join(SNAPSHOT_DIR, 'branch-form.expected.md')
const TREE_EXPECTED = join(SNAPSHOT_DIR, 'tree.expected.md')
const NARROW_EXPECTED = join(SNAPSHOT_DIR, 'narrow-pager.expected.md')
const ZH_EXPECTED = join(SNAPSHOT_DIR, 'zh.expected.md')
const ROUTE_EXPECTED = join(SNAPSHOT_DIR, 'route-menu.expected.md')
const OVERLAY = fileURLToPath(new URL('./loom.overlay.yml', import.meta.url))
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/experimental/loom-bundle/package.json', import.meta.url)),
]
const MODE = webSnapshotMode()
const ROOT_ID = 'loom-branching-root'
const BRANCH_A = 'loom-branching-a'
const BRANCH_B = 'loom-branching-b'
const TITLE = 'Loom branching'
const TITLE_A = 'Branch A'
const MARKER = 'LOOM_BRANCHING'
const ANSWER_A = `${MARKER} Branch A answers turn 2.`
const EDITED = `${MARKER} Take the shortest approach from here.`
const LINE = `${MARKER} Answer in one word.`
const ROUTE_LINE = `${MARKER} Answer on the other route.`
/** Children after the first: one regenerate sibling, one edited sibling, two samples, and one on a chosen route. */
const CHILD_FIXTURES = 5

/** The root: a writable folder and two closed turns opened by user prompts. */
function rootFixture(createdAt: number): string {
  const session = Session.create(SessionId('loom-branching-template'))
  session.append('sandbox/mode', { mode: 'workspace-write' })
  appendOpenedTurn(session, 1, `${MARKER} Plan the change.`, `${MARKER} Root answers turn 1.`, TITLE)
  appendOpenedTurn(session, 2, `${MARKER} Write the change.`, `${MARKER} Root answers turn 2.`, TITLE)
  return seedFixtureText(session, createdAt)
}

describe.skipIf(MODE === 'record')('web e2e: Loom branching', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let zhContext: BrowserContext | undefined
  let touchContext: BrowserContext | undefined
  let touch: { page: Page; tripwire: ReturnType<typeof watchConsole> } | undefined
  let page: Page
  let sidecar: string
  let readyFile: string
  let tripwire: ReturnType<typeof watchConsole>
  const rootChildren: SessionId[] = []
  let stopWatchingChildren: (() => void) | undefined

  beforeAll(async () => {
    sidecar = await mkdtemp(join(tmpdir(), 'dsh-web-loom-branching-'))
    readyFile = join(sidecar, 'hang-ready')
    const replay = await writeReplayInputs(sidecar, readyFile, CHILD_FIXTURES)
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY,
      extraInstallAnchors: INSTALL_ANCHORS,
      replayFixture: replay.primary,
      replayOverride: replay.override,
      replayChildFixtures: replay.children,
      paceMs: 50,
    })
    const rootCreatedAt = Date.now() - 60_000
    const fixtureText = rootFixture(rootCreatedAt)
    const cut = parseSeedFixture(fixtureText).events.find(event => event.type === 'turn/end' && event.data.turn === 1)
    if (cut === undefined) throw new Error('Loom branching root lacks turn/end for turn 1')
    await seedForkFamily(scaffold, { fixtureText, id: ROOT_ID, agentPreset: 'standard', createdAt: rootCreatedAt }, [
      {
        id: BRANCH_A,
        atSeq: cut.seq,
        createdAt: rootCreatedAt + 10_000,
        continueWith: (child) => {
          child.append('session/title', { title: TITLE_A, messageSeqs: [], source: { kind: 'user' } })
          appendOpenedTurn(child, 2, `${MARKER} Take the other approach from here.`, ANSWER_A, TITLE)
        },
      },
      { id: BRANCH_B, atSeq: cut.seq, createdAt: rootCreatedAt + 20_000 },
    ])
    // Opening a seeded fork resumes it and announces it again, so only new forks of the root count.
    const seeded = new Set<string>([BRANCH_A, BRANCH_B])
    stopWatchingChildren = scaffold.ctx.on('session/created', (session) => {
      if (session.header.parentSession === ROOT_ID && !seeded.has(session.id)) rootChildren.push(session.id)
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    stopWatchingChildren?.()
    const failures: unknown[] = []
    await zhContext?.close().catch((error: unknown) => failures.push(error))
    await touchContext?.close().catch((error: unknown) => failures.push(error))
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    await rm(sidecar, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'loom-branching e2e cleanup failed')
  })

  /** Expand the sidebar's workspace group and return its rows, the group row first. */
  async function sessionRows(target: Page, count: number): Promise<Locator> {
    const sessions = target.getByRole('tree').first()
    const groupRow = sessions.getByRole('treeitem').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    await expect.poll(() => sessions.getByRole('treeitem').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(count + 1)
    return sessions.getByRole('treeitem')
  }

  /** Accessible name of the focused element: its `aria-label`, else its text. */
  async function focusedName(target: Page): Promise<string> {
    return await target.evaluate(() => {
      const focused = document.activeElement
      return focused?.getAttribute('aria-label') ?? focused?.textContent?.trim() ?? ''
    })
  }

  /** The pager group of the open fork's first own turn. */
  function pager(index: number, count: number): Locator {
    return page.getByRole('group', { name: `Variant ${String(index)} of ${String(count)}`, exact: true })
  }

  it('regenerates a fork\'s first own turn into variants beside it while the strip follows the set', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-loom-branching-regenerate'))
    // The sidebar keeps each fork below its source.
    await sessionRows(page, 3)
    await page.locator(`[data-row-key="session:${BRANCH_A}"]`).click()
    await page.getByText(ANSWER_A, { exact: false }).last().waitFor({ timeout: 15_000 })
    await pager(1, 2).waitFor({ timeout: 15_000 })

    // The panel is driven from the keyboard: it takes focus once placed and returns it to the caret.
    const caret = page.getByRole('button', { name: 'Regenerate several' }).last()
    await caret.focus()
    await page.keyboard.press('Enter')
    const panel = page.getByRole('dialog', { name: 'Regenerate turn 2' })
    await panel.waitFor({ timeout: 15_000 })
    await panel.getByRole('button', { name: 'Change' }).waitFor({ timeout: 15_000 })
    await expect.poll(() => focusedName(page), { timeout: 15_000 }).toBe('×1')
    await compareOrRefreshGolden(REGENERATE_EXPECTED, await captureStableAria(page, '[role="dialog"][aria-label="Regenerate turn 2"]', scaffold.workspaceCwd), MODE)
    await page.keyboard.press('ArrowRight')
    expect(await panel.getByRole('radio', { name: '×2' }).getAttribute('aria-checked')).toBe('true')
    expect(await focusedName(page)).toBe('×2')
    await page.keyboard.press('Tab')
    expect(await focusedName(page)).toBe('Change')
    await page.keyboard.press('Tab')
    expect(await focusedName(page)).toContain('Run one at a time in the shared folder')
    await page.keyboard.press('Tab')
    expect(await focusedName(page)).toBe('Regenerate ×2')
    await page.keyboard.press('Enter')
    await panel.waitFor({ state: 'detached', timeout: 15_000 })
    await expect.poll(() => caret.evaluate(element => element === document.activeElement), { timeout: 15_000 }).toBe(true)

    // The first sibling holds the primary hang; the second waits for the folder.
    await expect.poll(() => existsSync(readyFile), { timeout: 30_000 }).toBe(true)
    const strip = page.locator('[data-loom-strip]')
    await expect.poll(() => strip.getByRole('status').textContent(), { timeout: 15_000 }).toBe('1 running · 1 queued')
    await compareOrRefreshGolden(STRIP_EXPECTED, await captureStableAria(page, '[data-loom-strip]', scaffold.workspaceCwd), MODE)
    await pager(1, 3).waitFor({ timeout: 15_000 })

    expect(rootChildren).toHaveLength(1)
    scaffold.ctx.sessionController.cancel({ sessionId: rootChildren[0]! })
    await expect.poll(async () => [
      await strip.locator('[data-loom-strip-item="done"]').count(),
      await strip.locator('[data-loom-strip-item="running"]').count(),
    ], { timeout: 30_000 }).toEqual([1, 1])
    await pager(1, 4).waitFor({ timeout: 30_000 })
    await strip.waitFor({ state: 'detached', timeout: 30_000 })
  })

  it('edits the fork\'s opening prompt into a further variant and opens it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-loom-branching-edit'))
    await page.getByRole('button', { name: 'Edit and branch' }).last().click()
    const panel = page.getByRole('dialog', { name: 'Edit turn 2 into a new branch' })
    await panel.waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(EDIT_EXPECTED, await captureStableAria(page, '[role="dialog"][aria-label="Edit turn 2 into a new branch"]', scaffold.workspaceCwd), MODE)
    await panel.getByRole('textbox', { name: 'Edited prompt' }).fill(EDITED)
    await panel.getByRole('button', { name: 'Branch', exact: true }).click()
    await page.getByText(EDITED, { exact: false }).last().waitFor({ timeout: 30_000 })
    await page.getByText(CHILD_REPLY, { exact: false }).last().waitFor({ timeout: 30_000 })
    await pager(5, 5).waitFor({ timeout: 30_000 })
    expect(rootChildren).toHaveLength(3)

    await page.locator('[data-loom-fork-band]').getByRole('button', { name: `Variant 1 of 5: ${TITLE_A}` }).click()
    await page.getByText(ANSWER_A, { exact: false }).last().waitFor({ timeout: 15_000 })
    await pager(1, 5).waitFor({ timeout: 15_000 })
  })

  it('keeps a branch privately and samples one steering line into variants with tallies', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-loom-branching-variants'))
    const keep = page.getByRole('group', { name: 'Private marks' }).getByRole('button', { name: 'Keep' })
    await keep.click()
    await expect.poll(() => keep.getAttribute('aria-pressed'), { timeout: 15_000 }).toBe('true')
    await compareOrRefreshGolden(FLOW_EXPECTED, await captureStableAria(page, '[data-chat-flow]', scaffold.workspaceCwd), MODE)

    const caret = page.getByRole('button', { name: 'Branch several' }).last()
    const form = page.locator('[data-loom-branch-form]')
    const focusOnCaret = (): Promise<boolean> => caret.evaluate(element => element === document.activeElement)
    // Cancel and Escape close the form and return keyboard focus to the caret that opened it.
    await caret.click()
    await form.waitFor({ timeout: 15_000 })
    await form.getByRole('button', { name: 'Cancel' }).click()
    await form.waitFor({ state: 'detached', timeout: 15_000 })
    await expect.poll(focusOnCaret, { timeout: 15_000 }).toBe(true)
    await caret.click()
    await form.waitFor({ timeout: 15_000 })
    await form.getByRole('textbox', { name: 'Steering line 1' }).focus()
    await page.keyboard.press('Escape')
    await form.waitFor({ state: 'detached', timeout: 15_000 })
    await expect.poll(focusOnCaret, { timeout: 15_000 }).toBe(true)
    await caret.click()
    await form.waitFor({ timeout: 15_000 })
    await form.getByRole('textbox', { name: 'Steering line 1' }).fill(LINE)
    await form.getByRole('button', { name: 'Remove line 2' }).click()
    await form.getByRole('radiogroup', { name: 'Samples per line' }).getByRole('radio', { name: '×2' }).click()
    await form.getByRole('button', { name: 'Start 2 branches' }).waitFor({ timeout: 15_000 })
    await form.getByRole('button', { name: 'Change' }).waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(FORM_EXPECTED, await captureStableAria(page, '[data-loom-branch-form]', scaffold.workspaceCwd), MODE)
    await form.getByRole('button', { name: 'Start 2 branches' }).click()
    await form.waitFor({ state: 'detached', timeout: 15_000 })
    // A started branch leaves the caret that opened the form focused, although the caret has collapsed by then.
    await expect.poll(focusOnCaret, { timeout: 15_000 }).toBe(true)
    const strip = page.locator('[data-loom-strip]')
    await strip.waitFor({ timeout: 15_000 })
    await strip.waitFor({ state: 'detached', timeout: 60_000 })

    await page.getByRole('tab', { name: 'Loom' }).click()
    const tree = page.getByRole('tree', { name: 'Fork family' })
    await tree.waitFor({ timeout: 15_000 })
    await expect.poll(() => tree.getByRole('treeitem').count(), { timeout: 15_000 }).toBe(10)
    const tallies = page.getByRole('region', { name: 'Prompt variants' })
    await expect.poll(() => tallies.textContent(), { timeout: 15_000 }).toContain('2 samples')
    const samples = tree.locator('[role="treeitem"][aria-level="5"]')
    await samples.nth(0).focus()
    await page.keyboard.press('k')
    await samples.nth(1).focus()
    await page.keyboard.press('x')
    await expect.poll(() => tallies.textContent(), { timeout: 15_000 }).toContain('1 kept · 1 set aside')
    await compareOrRefreshGolden(
      TREE_EXPECTED,
      [
        await captureStableAria(page, '[data-loom-view] [role="tree"]', scaffold.workspaceCwd),
        '',
        await captureStableAria(page, '[data-loom-view] section[aria-label="Prompt variants"]', scaffold.workspaceCwd),
      ].join('\n'),
      MODE,
    )

    // g on the current Session's row opens the form in the dock although Chat is not the open view: it still
    // names the Session's route, and Escape returns keyboard focus to the tree row.
    const current = tree.locator('[role="treeitem"][aria-selected="true"]')
    await current.focus()
    await page.keyboard.press('g')
    const fromTree = page.locator('[data-loom-branch-form]')
    await fromTree.waitFor({ timeout: 15_000 })
    await expect.poll(() => fromTree.textContent(), { timeout: 15_000 }).toContain('DeepSeek-V4-Flash')
    await page.keyboard.press('Escape')
    await fromTree.waitFor({ state: 'detached', timeout: 15_000 })
    await expect.poll(() => current.evaluate(element => element === document.activeElement), { timeout: 15_000 }).toBe(true)
  })

  /** A touch device without hover on Branch A's first own turn, opened from the Loom tree and narrowed to a phone. */
  async function phone(): Promise<{ page: Page; tripwire: ReturnType<typeof watchConsole> }> {
    if (touch !== undefined) return touch
    touchContext = await browser.newContext({
      viewport: { width: 1680, height: 1000 }, hasTouch: true, isMobile: true, locale: 'en-US', timezoneId: 'Asia/Shanghai',
    })
    const opened = await touchContext.newPage()
    const watched = watchConsole(opened)
    await opened.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await opened.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // A device that hovers would change the layout for another reason, so the emulation is checked first.
    expect(await opened.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true)
    // Every listed Session belongs to the fork family; its tree lists branch A first among the root's forks.
    await (await sessionRows(opened, 5)).nth(1).click()
    await opened.getByRole('tab', { name: 'Loom' }).click()
    const tree = opened.getByRole('tree', { name: 'Fork family' })
    await tree.waitFor({ timeout: 15_000 })
    await expect.poll(() => tree.getByRole('treeitem').count(), { timeout: 15_000 }).toBe(10)
    await tree.locator('[role="treeitem"][aria-level="3"]').first().focus()
    await opened.keyboard.press('Enter')
    await opened.getByRole('button', { name: `Open in Chat: ${TITLE_A}` }).click()
    await opened.getByText(ANSWER_A, { exact: false }).last().waitFor({ timeout: 15_000 })
    await opened.getByRole('group', { name: 'Variant 1 of 5', exact: true }).waitFor({ timeout: 15_000 })
    await opened.setViewportSize({ width: 390, height: 844 })
    expect(await opened.evaluate(() => matchMedia('(max-width: 480px)').matches)).toBe(true)
    touch = { page: opened, tripwire: watched }
    return touch
  }

  it('gives the pager its own row with 44px targets at 390px on a touch device', async () => {
    const { page: narrow } = await phone()
    onTestFailed(() => saveFailureShot(narrow, 'web-e2e-loom-branching-narrow'))
    const group = narrow.getByRole('group', { name: 'Variant 1 of 5', exact: true })
    await group.scrollIntoViewIfNeeded()
    const facts = await group.evaluate((element) => {
      const box = element.getBoundingClientRect()
      const row = element.parentElement
      const siblings = row === null ? [] : [...row.children].filter(child => child !== element)
      const sameRow = siblings.filter((child) => {
        const other = child.getBoundingClientRect()
        return other.height > 0 && other.top < box.bottom - 1 && other.bottom > box.top + 1
      })
      const buttons = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect())
      const visibleText = [...element.querySelectorAll('[aria-hidden="true"] span')]
        .filter(span => getComputedStyle(span).display !== 'none')
        .map(span => span.textContent)
      return {
        ownRow: sameRow.length === 0,
        targets: buttons.map(button => `${String(Math.round(button.width))}x${String(Math.round(button.height))}`),
        visibleText,
      }
    })
    const pageScrolls = await narrow.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(facts.ownRow).toBe(true)
    expect(facts.targets).toEqual(['44x44', '44x44'])
    expect(facts.visibleText).toEqual(['Variant 1 of 5'])
    expect(pageScrolls).toBe(false)
    await compareOrRefreshGolden(
      NARROW_EXPECTED,
      [
        '# Loom pager at 390px',
        '',
        `own row: ${String(facts.ownRow)}`,
        `targets: ${facts.targets.join(', ')}`,
        `visible count: ${facts.visibleText.join(', ')}`,
        `page scrolls sideways: ${String(pageScrolls)}`,
        '',
        await captureStableAria(narrow, '[data-loom-pager]', scaffold.workspaceCwd),
      ].join('\n'),
      MODE,
    )
  })

  it('keeps the names of Keep and Set aside visible at 390px on a touch device without hover', async () => {
    const { page: narrow, tripwire: narrowTripwire } = await phone()
    onTestFailed(() => saveFailureShot(narrow, 'web-e2e-loom-branching-touch'))
    const marks = narrow.getByRole('group', { name: 'Private marks' })
    await marks.waitFor({ timeout: 15_000 })
    await marks.scrollIntoViewIfNeeded()
    const buttons = await marks.locator('button').evaluateAll(elements => elements.map((button) => {
      const label = [...button.querySelectorAll('span')].find(span => getComputedStyle(span).display !== 'none')
      return {
        name: button.getAttribute('aria-label'),
        description: button.getAttribute('aria-description'),
        visible: label?.textContent ?? null,
        fits: button.scrollWidth <= button.clientWidth,
      }
    }))
    expect(buttons).toEqual([
      { name: 'Keep', description: 'Keep this branch: private, never sent as feedback', visible: 'Keep', fits: true },
      { name: 'Set aside', description: 'Set this branch aside: private, never sent as feedback', visible: 'Set aside', fits: true },
    ])
    expect(await narrow.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
    expect(narrowTripwire.pageErrors).toEqual([])
    expect(narrowTripwire.warnings).toEqual([])
  })

  it('renders the branch actions and the Regenerate panel in Chinese', async () => {
    zhContext = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai' })
    const zh = await zhContext.newPage()
    onTestFailed(() => saveFailureShot(zh, 'web-e2e-loom-branching-zh'))
    const zhTripwire = watchConsole(zh)
    await zh.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await zh.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // Every listed Session belongs to the family, whose tree lists branch A first among the root's forks;
    // the sidebar shows the five most recent.
    await (await sessionRows(zh, 5)).nth(1).click()
    await zh.getByRole('tab', { name: '织机' }).click()
    const tree = zh.getByRole('tree', { name: 'fork 家族' })
    await tree.waitFor({ timeout: 15_000 })
    await expect.poll(() => tree.getByRole('treeitem').count(), { timeout: 15_000 }).toBe(10)
    await tree.locator('[role="treeitem"][aria-level="3"]').first().focus()
    await zh.keyboard.press('Enter')
    await zh.getByRole('button', { name: `在对话中打开：${TITLE_A}` }).click()
    await zh.getByText(ANSWER_A, { exact: false }).last().waitFor({ timeout: 15_000 })
    await zh.getByRole('group', { name: '变体 1/5', exact: true }).waitFor({ timeout: 15_000 })
    const flow = await captureStableAria(zh, '[data-chat-flow]', scaffold.workspaceCwd)
    await zh.locator('[data-loom-regenerate] button[aria-haspopup="dialog"]').last().click()
    const panel = zh.getByRole('dialog', { name: '重新生成第 2 轮' })
    await panel.waitFor({ timeout: 15_000 })
    const regenerate = await captureStableAria(zh, '[role="dialog"]', scaffold.workspaceCwd)
    await zh.keyboard.press('Escape')
    await panel.waitFor({ state: 'detached', timeout: 15_000 })
    await compareOrRefreshGolden(ZH_EXPECTED, ['## Chat', '', flow, '', '## Regenerate', '', regenerate].join('\n'), MODE)
    expect(zhTripwire.pageErrors).toEqual([])
    expect(zhTripwire.warnings).toEqual([])
  })

  it('starts one branch on a route chosen for that branch only, with the model-switch notice in its log', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-loom-branching-route'))
    const catalog = await scaffold.ctx.sessionController.modelCatalog()
    const routes = catalog.groups.filter(group => catalog.routableProviders.includes(group.id))
      .flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id })))
    expect(routes.length, 'the route menu offers at least two routes').toBeGreaterThanOrEqual(2)
    const chosen = routes[1]!
    const created: Session[] = []
    const stop = scaffold.ctx.on('session/created', (session) => {
      if (session.header.parentSession === BRANCH_A) created.push(session)
    })
    try {
      // The page still shows the Loom tree; branch A is the open Session.
      await page.getByRole('tab', { name: 'Chat' }).click()
      await page.getByRole('button', { name: 'Branch several' }).last().click()
      const form = page.locator('[data-loom-branch-form]')
      await form.waitFor({ timeout: 15_000 })
      await form.getByRole('textbox', { name: 'Steering line 1' }).fill(ROUTE_LINE)
      await form.getByRole('button', { name: 'Remove line 2' }).click()
      await form.getByRole('button', { name: 'Change' }).click()
      const menu = page.getByRole('menu')
      await menu.waitFor({ timeout: 15_000 })
      await compareOrRefreshGolden(ROUTE_EXPECTED, await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), MODE)
      // The first row keeps the parent's route; the catalog's routes follow in order.
      await menu.getByRole('menuitem').nth(2).click()
      await menu.waitFor({ state: 'detached', timeout: 15_000 })
      await expect.poll(() => form.textContent(), { timeout: 15_000 }).toContain('For these branches only')
      await form.getByRole('button', { name: 'Start 1 branch' }).click()
      await form.waitFor({ state: 'detached', timeout: 15_000 })
      const ownPrompts = (session: Session): string[] => session.snapshotEvents().slice(session.inheritedEventCount).flatMap(event =>
        event.type === 'user/message' && event.data.source.kind === 'user'
          ? [event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')]
          : [])
      await expect.poll(() => created.some(session => ownPrompts(session).includes(ROUTE_LINE)), { timeout: 30_000 }).toBe(true)
      const child = created.find(session => ownPrompts(session).includes(ROUTE_LINE))!
      await scaffold.ctx.agents.get(child.id)?.whenIdle()
      await scaffold.ctx.sessions.flush(child)
      const own = child.snapshotEvents().slice(child.inheritedEventCount)
      const header = own.find(event => event.type === 'request/header')
      expect(header?.data.header.config).toMatchObject(chosen)
      // The Host resolves the route and adds the model's default effort.
      expect(own.flatMap(event => event.type === 'model/selection' ? [event.data] : [])).toMatchObject([chosen])
      // The notice is the agent loop's own and appears exactly when the route differs from the one the history ran on.
      const inherited = child.snapshotEvents().slice(0, child.inheritedEventCount).findLast(event => event.type === 'request/header')?.data.header.config
      const differs = inherited?.provider !== chosen.provider || inherited.model !== chosen.model
      expect(own.filter(event => event.type === 'user/message' && event.data.source.kind === 'model-selection')).toHaveLength(differs ? 1 : 0)
    } finally {
      stop()
    }
  })

  it('kept the console clean and the fixture inventory closed', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'branch-form.expected.md', 'edit-panel.expected.md', 'flow.expected.md', 'narrow-pager.expected.md',
      'regenerate-panel.expected.md', 'route-menu.expected.md', 'strip.expected.md', 'tree.expected.md', 'zh.expected.md',
    ])
  })
})
