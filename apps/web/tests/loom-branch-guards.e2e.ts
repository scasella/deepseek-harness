// Keyless assembled-browser guards for the Loom branching actions that
// loom-branching.e2e.ts leaves untested, over a seeded fork family of three
// variants: the pager's keyboard model (one tab stop, arrows, Home, End), the
// private marks as toggles with their tree glyph, the Branch ×N form's
// duplicate-line and blank-line states in English and Chinese, Edit and branch
// on the message that opened a Turn and nowhere else, and the running strip
// for a child whose fork failed, for a regenerate set beside the dock's
// Session and for a steering set under it.
//
// Replay binding: the seeded family never calls the model. Loom children that
// share a writable folder run one at a time. The first child to reach the
// model claims the primary script, a hang that holds the folder until the test
// cancels it (the strip tests run in this order for that reason); the next
// child to reach the model claims the one recorded single-call fixture.
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi, type MockInstance } from 'vitest'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { appendOpenedTurn, appendSteeredTurn, seedFixtureText, writeReplayInputs } from './loom-support.ts'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  parseSeedFixture, seedForkFamily, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/loom-branch-guards', import.meta.url))
const PAGER_EXPECTED = join(SNAPSHOT_DIR, 'pager-keys.expected.md')
const MARKS_EXPECTED = join(SNAPSHOT_DIR, 'marks.expected.md')
const TREE_EXPECTED = join(SNAPSHOT_DIR, 'tree-marks.expected.md')
const DUPLICATE_EXPECTED = join(SNAPSHOT_DIR, 'form-duplicate.expected.md')
const BLANK_EXPECTED = join(SNAPSHOT_DIR, 'form-blank.expected.md')
const ZH_FORM_EXPECTED = join(SNAPSHOT_DIR, 'form-duplicate.zh.expected.md')
const ROOT_EXPECTED = join(SNAPSHOT_DIR, 'edit-offers.expected.md')
const FAILED_EXPECTED = join(SNAPSHOT_DIR, 'strip-failed.expected.md')
const OVERLAY = fileURLToPath(new URL('./loom.overlay.yml', import.meta.url))
const INSTALL_ANCHORS = [
  fileURLToPath(new URL('../../../packages/experimental/loom-bundle/package.json', import.meta.url)),
]
const MODE = webSnapshotMode()
const ROOT_ID = 'loom-guards-root'
const TITLE = 'Loom guards'
const MARKER = 'LOOM_GUARDS'
/** The family's variants in creation order; their rows sort newest first in the sidebar. */
const FORKS = [
  { id: 'loom-guards-a', letter: 'A' },
  { id: 'loom-guards-b', letter: 'B' },
  { id: 'loom-guards-c', letter: 'C' },
] as const
const LINE = `${MARKER} Answer in one word.`
const LINES = [`${MARKER} Answer in French.`, `${MARKER} Answer in German.`, `${MARKER} Answer in Spanish.`] as const
/** The failure the stubbed fork reports for the second child. */
const FORK_FAILURE = 'The fork cannot be created'

/** Stable identities of the family's sidebar rows. */
const ROWS = { C: 'loom-guards-c', B: 'loom-guards-b', A: 'loom-guards-a', root: ROOT_ID } as const

const answerOf = (letter: string): string => `${MARKER} Branch ${letter} answers turn 2.`
const titleOf = (letter: string): string => `Branch ${letter}`

/** The root: a writable folder, an opened turn 1, and a turn 2 that took a steering message. */
function rootFixture(createdAt: number): string {
  const session = Session.create(SessionId('loom-guards-template'))
  session.append('sandbox/mode', { mode: 'workspace-write' })
  appendOpenedTurn(session, 1, `${MARKER} Plan the change.`, `${MARKER} Root answers turn 1.`, TITLE)
  appendSteeredTurn(
    session, 2, `${MARKER} Write the change.`, `${MARKER} Also add a test.`,
    [`${MARKER} Root starts turn 2.`, `${MARKER} Root answers turn 2.`], TITLE,
  )
  return seedFixtureText(session, createdAt)
}

describe.skipIf(MODE === 'record')('web e2e: Loom branching guards', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let zhContext: BrowserContext | undefined
  let page: Page
  let sidecar: string
  let readyFile: string
  let tripwire: ReturnType<typeof watchConsole>
  const startedChildren: SessionId[] = []
  let stopWatchingChildren: (() => void) | undefined

  beforeAll(async () => {
    sidecar = await mkdtemp(join(tmpdir(), 'dsh-web-loom-guards-'))
    readyFile = join(sidecar, 'hang-ready')
    const replay = await writeReplayInputs(sidecar, readyFile, 1)
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
    if (cut === undefined) throw new Error('Loom guards root lacks turn/end for turn 1')
    await seedForkFamily(scaffold, { fixtureText, id: ROOT_ID, agentPreset: 'standard', createdAt: rootCreatedAt }, FORKS.map(({ id, letter }, index) => ({
      id,
      atSeq: cut.seq,
      createdAt: rootCreatedAt + 10_000 * (index + 1),
      continueWith: (child: Session) => {
        child.append('session/title', { title: titleOf(letter), messageSeqs: [], source: { kind: 'user' } })
        appendOpenedTurn(child, 2, `${MARKER} Take approach ${letter} from here.`, answerOf(letter), TITLE)
      },
    })))
    // Opening a seeded fork resumes it and announces it again, so only new forks count.
    const seeded = new Set<string>(FORKS.map(({ id }) => id))
    stopWatchingChildren = scaffold.ctx.on('session/created', (session) => {
      if (session.header.parentSession !== undefined && !seeded.has(session.id)) startedChildren.push(session.id)
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    stopWatchingChildren?.()
    vi.restoreAllMocks()
    const failures: unknown[] = []
    await zhContext?.close().catch((error: unknown) => failures.push(error))
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    await rm(sidecar, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'loom-branch-guards e2e cleanup failed')
  })

  /**
   * Open one listed Session and wait for text its Chat shows. The sidebar
   * reads a seeded Session's title only once it is opened; its identity is stable before that read.
   */
  async function openSession(target: Page, row: keyof typeof ROWS, text: string): Promise<void> {
    const rows = target.getByRole('tree').first().getByRole('treeitem')
    await rows.first().waitFor({ timeout: 15_000 })
    // A collapsed workspace group lists only itself.
    if (await rows.count() === 1) await rows.first().click()
    await target.locator(`[data-row-key="session:${ROWS[row]}"]`).click()
    await target.getByText(text, { exact: false }).last().waitFor({ timeout: 15_000 })
  }

  /** The pager group of the open fork's first own turn. */
  function pager(target: Page, index: number, count: number): Locator {
    return target.getByRole('group', { name: `Variant ${String(index)} of ${String(count)}`, exact: true })
  }

  /** What the pager's buttons expose to Tab and to assistive technology. */
  async function stopsOf(group: Locator): Promise<string[]> {
    return group.locator('button').evaluateAll(buttons => buttons.map(button => [
      `${button.getAttribute('aria-label') ?? ''}: tabindex ${String(button.tabIndex)}`,
      button.getAttribute('aria-disabled') === 'true' ? ', aria-disabled' : '',
    ].join('')))
  }

  /** The label of the focused element. */
  async function focused(target: Page): Promise<string> {
    return target.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? 'none')
  }

  it('steps through the pager with one tab stop, arrow keys, Home and End', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-loom-guards-pager'))
    await openSession(page, 'A', answerOf('A'))
    const first = pager(page, 1, 3)
    await first.waitFor({ timeout: 15_000 })
    const log = ['# Variant pager keyboard', '', '## Variant 1 of 3', ...await stopsOf(first).then(stops => stops.map(stop => `- ${stop}`))]
    expect((await stopsOf(first)).filter(stop => stop.includes('tabindex 0'))).toHaveLength(1)

    // Tab enters the pager once and leaves it on the next press.
    await page.getByRole('button', { name: 'Branch several' }).last().focus()
    const walk: string[] = []
    await page.keyboard.press('Tab')
    walk.push(await focused(page))
    await page.keyboard.press('Tab')
    walk.push(await focused(page))
    await page.keyboard.press('Shift+Tab')
    walk.push(await focused(page))
    expect(walk).toEqual(['Next variant', 'Regenerate once', 'Next variant'])
    log.push('', `Tab, Tab, Shift+Tab from Branch several: ${walk.join(' → ')}`)

    // The arrows move focus between the two buttons, including onto the unavailable end.
    const arrows: string[] = []
    await page.keyboard.press('ArrowLeft')
    arrows.push(await focused(page))
    await page.keyboard.press('ArrowRight')
    arrows.push(await focused(page))
    expect(arrows).toEqual(['Previous variant', 'Next variant'])
    log.push(`ArrowLeft, ArrowRight: ${arrows.join(' → ')}`)

    // Home on the first variant stays on it; Enter opens the next one.
    await page.keyboard.press('Home')
    expect(await first.count()).toBe(1)
    log.push('Home on variant 1: stays on variant 1 of 3')
    await page.keyboard.press('Enter')
    const middle = pager(page, 2, 3)
    await middle.waitFor({ timeout: 15_000 })
    await page.getByText(answerOf('B'), { exact: false }).last().waitFor({ timeout: 15_000 })
    log.push('Enter on Next variant: opens variant 2 of 3', '', '## Variant 2 of 3', ...await stopsOf(middle).then(stops => stops.map(stop => `- ${stop}`)))
    expect((await stopsOf(middle)).filter(stop => stop.includes('tabindex 0'))).toHaveLength(1)
    log.push('', await captureStableAria(page, '[data-loom-pager]', scaffold.workspaceCwd))

    // End opens the last variant, whose single tab stop moves to the available end.
    await middle.getByRole('button', { name: 'Next variant' }).focus()
    await page.keyboard.press('End')
    const last = pager(page, 3, 3)
    await last.waitFor({ timeout: 15_000 })
    await page.getByText(answerOf('C'), { exact: false }).last().waitFor({ timeout: 15_000 })
    const lastStops = await stopsOf(last)
    expect(lastStops.filter(stop => stop.includes('tabindex 0'))).toEqual(['Previous variant: tabindex 0'])
    log.push('', 'End: opens variant 3 of 3', '', '## Variant 3 of 3', ...lastStops.map(stop => `- ${stop}`))

    await last.getByRole('button', { name: 'Previous variant' }).focus()
    await page.keyboard.press('Home')
    await first.waitFor({ timeout: 15_000 })
    await page.getByText(answerOf('A'), { exact: false }).last().waitFor({ timeout: 15_000 })
    log.push('', 'Home: opens variant 1 of 3')
    await compareOrRefreshGolden(PAGER_EXPECTED, log.join('\n'), MODE)
  })

  it('toggles the private marks and shows the mark in the tree row name and glyph', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-loom-guards-marks'))
    await openSession(page, 'C', answerOf('C'))
    const group = page.getByRole('group', { name: 'Private marks' })
    const keep = group.getByRole('button', { name: 'Keep' })
    const setAside = group.getByRole('button', { name: 'Set aside' })
    const state = async (): Promise<string> => `Keep ${await keep.getAttribute('aria-pressed') ?? 'none'}, Set aside ${await setAside.getAttribute('aria-pressed') ?? 'none'}`
    const settle = async (expected: string): Promise<string> => {
      await expect.poll(state, { timeout: 15_000 }).toBe(expected)
      return expected
    }
    const log = ['# Private marks', '', `start: ${await settle('Keep false, Set aside false')}`]
    await keep.click()
    log.push(`Keep: ${await settle('Keep true, Set aside false')}`)
    await setAside.click()
    log.push(`Set aside: ${await settle('Keep false, Set aside true')}`)
    await setAside.click()
    log.push(`Set aside again: ${await settle('Keep false, Set aside false')}`)
    await setAside.click()
    log.push(`Set aside: ${await settle('Keep false, Set aside true')}`, '', await captureStableAria(page, '[data-loom-marks]', scaffold.workspaceCwd))
    await compareOrRefreshGolden(MARKS_EXPECTED, log.join('\n'), MODE)

    // The tree names the mark and draws its glyph; the glyph itself is hidden from assistive technology.
    await page.getByRole('tab', { name: 'Loom' }).click()
    const tree = page.getByRole('tree', { name: 'Fork family' })
    await tree.waitFor({ timeout: 15_000 })
    const rowOf = (letter: string): Locator => tree.getByRole('treeitem', { name: new RegExp(`^${titleOf(letter)},`, 'u') })
    const glyphOf = (row: Locator): Promise<string> => row.evaluate((element) => {
      const glyph = element.querySelector('span[aria-hidden="true"] svg')
      if (glyph === null) return 'none'
      return `${glyph.querySelector('rect') === null ? 'keep' : 'set-aside'} ${glyph.getAttribute('width') ?? '?'}px`
    })
    await expect.poll(() => rowOf('C').getAttribute('aria-label'), { timeout: 15_000 }).toMatch(/, set aside$/u)
    await rowOf('C').focus()
    await page.keyboard.press('k')
    await expect.poll(() => rowOf('C').getAttribute('aria-label'), { timeout: 15_000 }).toMatch(/, kept$/u)
    await rowOf('A').focus()
    await page.keyboard.press('x')
    await expect.poll(() => rowOf('A').getAttribute('aria-label'), { timeout: 15_000 }).toMatch(/, set aside$/u)
    const glyphs = {
      'Branch A': await glyphOf(rowOf('A')),
      'Branch B': await glyphOf(rowOf('B')),
      'Branch C': await glyphOf(rowOf('C')),
    }
    expect(glyphs).toEqual({ 'Branch A': 'set-aside 12px', 'Branch B': 'none', 'Branch C': 'keep 12px' })
    await compareOrRefreshGolden(
      TREE_EXPECTED,
      [
        await captureStableAria(page, '[data-loom-view] [role="tree"]', scaffold.workspaceCwd),
        '',
        ...Object.entries(glyphs).map(([name, glyph]) => `${name} glyph: ${glyph}`),
      ].join('\n'),
      MODE,
    )
    await page.getByRole('tab', { name: 'Chat' }).click()
  })

  it('flags repeated and blank steering lines in the Branch ×N form', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-loom-guards-form'))
    await page.getByRole('button', { name: 'Branch several' }).last().click()
    const form = page.locator('[data-loom-branch-form]')
    await form.waitFor({ timeout: 15_000 })
    // The form opens with two empty lines.
    await form.getByRole('textbox', { name: 'Steering line 1' }).fill(LINE)
    await form.getByRole('textbox', { name: 'Steering line 2' }).fill(LINE)
    await form.getByRole('button', { name: 'Add branch' }).click()
    await form.getByRole('textbox', { name: 'Steering line 3' }).fill(LINES[0])
    await form.getByRole('radiogroup', { name: 'Samples per line' }).getByRole('radio', { name: '×2' }).click()
    await form.getByText('Rows 1 and 2 share a line: samples of one prompt').waitFor({ timeout: 15_000 })
    await form.getByRole('button', { name: 'Start 6 branches' }).waitFor({ timeout: 15_000 })
    await form.getByRole('button', { name: 'Change' }).waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(DUPLICATE_EXPECTED, await captureStableAria(page, '[data-loom-branch-form]', scaffold.workspaceCwd), MODE)

    await form.getByRole('button', { name: 'Add branch' }).click()
    await form.getByText('Fill in every line, or remove empty ones').waitFor({ timeout: 15_000 })
    expect(await form.getByRole('button', { name: 'Start 8 branches' }).isDisabled()).toBe(true)
    await compareOrRefreshGolden(BLANK_EXPECTED, await captureStableAria(page, '[data-loom-branch-form]', scaffold.workspaceCwd), MODE)

    await form.getByRole('button', { name: 'Remove line 4' }).click()
    await form.getByRole('button', { name: 'Remove line 2' }).click()
    await expect.poll(() => form.getByText(/share a line/u).count(), { timeout: 15_000 }).toBe(0)
    expect(await form.getByRole('button', { name: 'Start 4 branches' }).isEnabled()).toBe(true)
    await form.getByRole('button', { name: 'Cancel' }).click()
    await form.waitFor({ state: 'detached', timeout: 15_000 })
  })

  it('flags repeated steering lines in Chinese', async () => {
    zhContext = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai' })
    const zh = await zhContext.newPage()
    onTestFailed(() => saveFailureShot(zh, 'web-e2e-loom-guards-zh'))
    const zhTripwire = watchConsole(zh)
    await zh.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await zh.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openSession(zh, 'C', answerOf('C'))
    await zh.getByRole('button', { name: '多路分支' }).last().click()
    const form = zh.locator('[data-loom-branch-form]')
    await form.waitFor({ timeout: 15_000 })
    await form.getByRole('textbox', { name: '第 1 条引导语' }).fill(LINE)
    await form.getByRole('textbox', { name: '第 2 条引导语' }).fill(LINE)
    await form.getByRole('radiogroup', { name: '每行采样数' }).getByRole('radio', { name: '×3' }).click()
    await form.getByText(/第 1.{1,3}2 行内容相同：同一提示词的多次采样/u).waitFor({ timeout: 15_000 })
    await form.getByRole('button', { name: '开始 6 个分支' }).waitFor({ timeout: 15_000 })
    await form.getByRole('button', { name: '更换' }).waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(ZH_FORM_EXPECTED, await captureStableAria(zh, '[data-loom-branch-form]', scaffold.workspaceCwd), MODE)
    expect(zhTripwire.pageErrors).toEqual([])
    expect(zhTripwire.warnings).toEqual([])
  })

  it('offers Edit and branch on the message that opened a Turn and not on a steering message', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-loom-guards-edit'))
    await openSession(page, 'root', `${MARKER} Root answers turn 2.`)
    await page.getByText(`${MARKER} Also add a test.`, { exact: false }).last().waitFor({ timeout: 15_000 })
    const flow = page.locator('[data-chat-flow]')
    // Turn 1 and turn 2 each have an opening prompt; the steering message in turn 2 has no action.
    await expect.poll(() => flow.getByRole('button', { name: 'Edit and branch' }).count(), { timeout: 15_000 }).toBe(2)
    const steering = flow.getByText(`${MARKER} Also add a test.`, { exact: false }).last()
    const bubbleActions = await steering.evaluate((text) => {
      let scope: HTMLElement | null = text.parentElement
      while (scope !== null && scope.querySelectorAll('button').length === 0) scope = scope.parentElement
      return [...(scope?.querySelectorAll('button') ?? [])].map(button => button.getAttribute('aria-label') ?? button.textContent ?? '')
    })
    expect(bubbleActions).not.toContain('Edit and branch')
    await compareOrRefreshGolden(ROOT_EXPECTED, await captureStableAria(page, '[data-chat-flow]', scaffold.workspaceCwd), MODE)
  })

  /**
   * Make the nth fork the Loom runner asks the Session Controller for fail
   * with a typed error; every other fork runs for real.
   * @param nth - one-based number of the fork call to fail.
   * @returns the spy, to restore after the test.
   */
  function failForkNumber(nth: number): MockInstance<WebScaffold['ctx']['sessionController']['fork']> {
    const controller = scaffold.ctx.sessionController
    const real = controller.fork.bind(controller)
    let calls = 0
    return vi.spyOn(controller, 'fork').mockImplementation((request) => {
      calls += 1
      if (calls === nth) {
        return Promise.reject(new RemoteError('session/fork-unavailable', FORK_FAILURE, { sessionId: request.sessionId }))
      }
      return real(request)
    })
  }

  it('shows a child whose fork failed as failed beside the ended one, and dismisses the settled set', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-loom-guards-strip-failed'))
    const fork = failForkNumber(2)
    try {
      // Variant A's first own turn regenerates beside it, so the children are not children of the dock's Session.
      await openSession(page, 'A', answerOf('A'))
      await page.getByRole('button', { name: 'Regenerate several' }).last().click()
      const panel = page.getByRole('dialog', { name: 'Regenerate turn 2' })
      await panel.waitFor({ timeout: 15_000 })
      await panel.getByRole('radio', { name: '×2' }).click()
      await panel.getByRole('button', { name: 'Regenerate ×2' }).click()
      await panel.waitFor({ state: 'detached', timeout: 15_000 })

      // The first child claims the hang and holds the folder, so the second waits.
      await expect.poll(() => existsSync(readyFile), { timeout: 30_000 }).toBe(true)
      const strip = page.locator('[data-loom-strip]')
      await expect.poll(() => strip.getByRole('status').textContent(), { timeout: 15_000 }).toBe('1 running · 1 queued')
      expect(startedChildren).toHaveLength(1)

      // Ending the first child frees the folder; the second child's fork then fails.
      scaffold.ctx.sessionController.cancel({ sessionId: startedChildren[0]! })
      await expect.poll(() => strip.getByRole('status').textContent(), { timeout: 30_000 }).toBe('1 failed')
      expect(fork).toHaveBeenCalledTimes(2)
      expect(startedChildren).toHaveLength(1)
      await compareOrRefreshGolden(FAILED_EXPECTED, await captureStableAria(page, '[data-loom-strip]', scaffold.workspaceCwd), MODE)

      await strip.getByRole('button', { name: 'Dismiss' }).click()
      await strip.waitFor({ state: 'detached', timeout: 15_000 })
    } finally {
      fork.mockRestore()
    }
  })

  // The family lists the first child while `loom.branch` is still in flight, so the strip adopts the set before the
  // call returns; the returned set must replace that entry rather than add a second one.
  it('lists each child of a steering set once while the family shows the first child before the request returns', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-loom-guards-strip-once'))
    // The first fork succeeds and runs; the second fails once the first has ended.
    const fork = failForkNumber(2)
    try {
      await page.locator('[data-loom-fork-band]').getByRole('button', { name: /^Variant \d+ of \d+: Branch C$/u }).click()
      await page.getByText(answerOf('C'), { exact: false }).last().waitFor({ timeout: 15_000 })
      await page.getByRole('button', { name: 'Branch several' }).last().click()
      const form = page.locator('[data-loom-branch-form]')
      await form.waitFor({ timeout: 15_000 })
      await form.getByRole('textbox', { name: 'Steering line 1' }).fill(LINES[0])
      await form.getByRole('textbox', { name: 'Steering line 2' }).fill(LINES[1])
      await form.getByRole('button', { name: 'Start 2 branches' }).click()
      await form.waitFor({ state: 'detached', timeout: 15_000 })

      const strip = page.locator('[data-loom-strip]')
      await expect.poll(() => strip.getByRole('status').textContent(), { timeout: 20_000 }).toBe('1 failed')
      const items = strip.locator('[data-loom-strip-item]')
      expect(await items.evaluateAll(elements => elements.map(element => element.getAttribute('data-loom-strip-item')))).toEqual(['done', 'failed'])
      // A child that failed before it had a Session keeps its steering line as its name.
      expect(await items.nth(1).textContent()).toContain(LINES[1])
      expect(await strip.getByRole('button', { name: 'Dismiss' }).count()).toBe(1)
      await strip.getByRole('button', { name: 'Dismiss' }).click()
      await strip.waitFor({ state: 'detached', timeout: 15_000 })
    } finally {
      fork.mockRestore()
    }
  })

  it('kept the console clean and the fixture inventory closed', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'pager-keys.expected.md', 'marks.expected.md', 'tree-marks.expected.md', 'form-duplicate.expected.md',
      'form-blank.expected.md', 'form-duplicate.zh.expected.md', 'edit-offers.expected.md',
      'strip-failed.expected.md',
    ])
  })
})
