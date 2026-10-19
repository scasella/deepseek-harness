/** Keyless assembled-browser guard for outcome comparison, marks, adoption, and phone-width cards. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, SessionId, type Session } from '@deepseek-ai/dsh-session'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, parseSeedFixture, readPersistedEvents, seedForkFamily, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL('./loom.overlay.yml', import.meta.url))
const ANCHOR = fileURLToPath(new URL('../../../packages/experimental/loom-bundle/package.json', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/loom-compare', import.meta.url))

function appendOutcome(child: Session, name: string, passed: number, failed: number): void {
  child.append('turn/start', { turn: 2 })
  child.append('step/start', { turn: 2, step: 1 })
  child.append('user/message', createUserMessage({ content: [{ type: 'text', text: name }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const callId = ToolCallId(`compare-${name}`)
  const args = JSON.stringify({ command: 'pnpm test' })
  child.append('assistant/message', {
    turn: 2, step: 1, stream: [],
    message: createAssistantMessage({ content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: args }], source: { provider: 'fixture', model: 'fixture' } }),
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 },
  }, { surfaceOp: 'append' })
  const call = child.append('tool/call', { turn: 2, step: 1, callId, name: 'bash', arguments: args })
  child.append('tool/result', { turn: 2, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: `Tests  ${failed} failed | ${passed} passed (${failed + passed})` }], isError: failed > 0 }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  child.append('step/end', { turn: 2, step: 1 })
  child.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
}

describe.skipIf(MODE === 'record')('web e2e: Loom outcome comparison', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, extraInstallAnchors: [ANCHOR] })
    const root = createChatScrollFixture({ markerPrefix: 'LOOMCOMPARE', title: 'Compare family', turns: 1 })
    const cut = parseSeedFixture(root.log).events.find(event => event.type === 'turn/end')
    if (cut === undefined) throw new Error('Compare fixture has no completed turn')
    const createdAt = Date.now() - 60_000
    await seedForkFamily(scaffold, { fixtureText: root.log, id: 'compare-root', agentPreset: 'standard', createdAt }, [
      { id: 'compare-pass', atSeq: cut.seq, createdAt: createdAt + 10_000, continueWith: (child) => { appendOutcome(child, 'Passing approach', 4, 0) } },
      { id: 'compare-fail', atSeq: cut.seq, createdAt: createdAt + 20_000, continueWith: (child) => { appendOutcome(child, 'Failing approach', 3, 1) } },
    ])
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const sessions = page.getByRole('tree', { name: 'Sessions' })
    await sessions.getByRole('treeitem').first().click()
    await page.locator('[data-row-key="session:compare-pass"]').click()
    await page.getByRole('tab', { name: 'Loom', exact: true }).click()
    await page.getByRole('tab', { name: 'Compare', exact: true }).click()
    await page.getByRole('table', { name: 'Branch comparison' }).waitFor({ timeout: 15_000 })
  }, 120_000)
  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('persists a mark on a cold sibling before opening that Session', async () => {
    const id = SessionId('compare-fail')
    expect(scaffold.ctx.agents.get(id)).toBeUndefined()
    const keep = page.locator('[data-loom-compare-row="compare-fail"]').getByRole('button', { name: /^Keep:/ })
    await keep.click()
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button =>
      button.getAttribute('aria-label')?.startsWith('Keep:') && button.getAttribute('aria-pressed') === 'true'))
    await vi.waitFor(async () => {
      const persisted = await readPersistedEvents(scaffold, id)
      expect(persisted.some((event) => {
        const record = pluginRecordOf(event)
        return record?.type === 'plugin:loom/mark' && record.data !== null && typeof record.data === 'object'
          && 'mark' in record.data && record.data.mark === 'keep'
      })).toBe(true)
    }, { timeout: 10_000 })
    await keep.click()
    await page.waitForFunction(() => [...document.querySelectorAll('button')].every(button =>
      !button.getAttribute('aria-label')?.startsWith('Keep:') || button.getAttribute('aria-pressed') === 'false'))
  })

  it('compares own test outcomes and tokens and opens a selected branch', async () => {
    const compare = page.locator('[data-loom-compare]')
    await compare.getByText('4 passed', { exact: false }).waitFor()
    await compare.getByText('1 of 4 failed', { exact: false }).waitFor()
    await compareOrRefreshGolden(join(EXPECTED, 'table.expected.md'), await captureStableAria(page, '[data-loom-compare]', scaffold.workspaceCwd), MODE)
    await compare.getByRole('radio').first().check()
    await compare.getByRole('button', { name: 'Adopt', exact: true }).waitFor()
    await compareOrRefreshGolden(join(EXPECTED, 'detail.expected.md'), await captureStableAria(page, '[data-loom-compare]', scaffold.workspaceCwd), MODE)
  })

  it('keeps every primary action reachable at 390 pixels', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    const compare = page.locator('[data-loom-compare]')
    expect(await compare.getByRole('button', { name: 'Adopt', exact: true }).isVisible()).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await compareOrRefreshGolden(join(EXPECTED, 'phone.expected.md'), await captureStableAria(page, '[data-loom-compare]', scaffold.workspaceCwd), MODE)
    await page.setViewportSize({ width: 1680, height: 1050 })
  })

  it('adopts the selected branch and archives its sibling', async () => {
    await page.getByRole('button', { name: 'Adopt', exact: true }).click()
    await page.getByRole('button', { name: 'Adopted', exact: true }).waitFor()
    await compareOrRefreshGolden(join(EXPECTED, 'adopted.expected.md'), await captureStableAria(page, '[data-loom-compare]', scaffold.workspaceCwd), MODE)
  })
})
