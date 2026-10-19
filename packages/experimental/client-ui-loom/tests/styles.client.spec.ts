/**
 * Branching stylesheets, read from disk: every theme token they name exists,
 * hover fills apply only on devices that hover, the marks keep their labels on
 * devices that do not, and at phone width the pager and the dock controls grow
 * to 44px targets. jsdom evaluates neither media
 * nor container queries, so the rules themselves are asserted.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SHEETS = [
  'TailActions', 'Dock', 'panel', 'CountChoice', 'RouteRow', 'LoomTree', 'LoomView', 'CompareView', 'CompareDetail', 'IsolationRow',
] as const
const sheets = Object.fromEntries(SHEETS.map(name => [name, readFileSync(
  fileURLToPath(new URL(`../src/client/${name}.module.css`, import.meta.url)),
  'utf8',
)])) as Record<(typeof SHEETS)[number], string>
const tokens = readdirSync(fileURLToPath(new URL('../../../client/ui-theme/src/styles/', import.meta.url)))
  .filter(name => name.endsWith('.css'))
  .map(name => readFileSync(fileURLToPath(new URL(`../../../client/ui-theme/src/styles/${name}`, import.meta.url)), 'utf8'))
  .join('\n')

/**
 * The body of the first block opened by a prelude.
 * @param sheet - stylesheet text.
 * @param prelude - text that opens the block, such as an at-rule.
 * @returns the block's text between its braces.
 */
function block(sheet: string, prelude: string): string {
  const start = sheet.indexOf(prelude)
  if (start < 0) throw new Error(`no block ${prelude}`)
  let depth = 0
  const open = sheet.indexOf('{', start)
  for (let index = open; index < sheet.length; index += 1) {
    if (sheet[index] === '{') depth += 1
    else if (sheet[index] === '}' && --depth === 0) return sheet.slice(open + 1, index)
  }
  throw new Error(`unclosed block ${prelude}`)
}

describe('branching stylesheets', () => {
  it('name only theme tokens the theme declares', () => {
    for (const [name, sheet] of Object.entries(sheets)) {
      const used = [...new Set([...sheet.matchAll(/var\((--dsw-[\w-]+)/gu)].map(match => match[1]))]
      for (const token of used) expect(tokens, `${name} uses ${String(token)}`).toContain(`${String(token)}:`)
    }
  })

  it('fill hovered controls only on devices that hover', () => {
    for (const name of ['TailActions', 'Dock', 'CompareView', 'CompareDetail', 'IsolationRow'] as const) {
      const sheet = sheets[name]
      const outside = sheet.replace(block(sheet, '@media (hover: hover)'), '')
      expect(outside).not.toMatch(/:hover/u)
      expect(block(sheet, '@media (hover: hover)')).toMatch(/:hover/u)
    }
  })

  it('give the pager its own row of 44px targets and the dock 44px controls at phone width', () => {
    const tail = block(sheets.TailActions, '@media (max-width: 480px)')
    expect(block(tail, '.pager {')).toMatch(/flex: 1 0 100%/u)
    expect(block(tail, '.pagerButton')).toMatch(/width: 44px;[\s\S]*height: 44px;/u)
    expect(block(tail, '.countLong')).toMatch(/display: inline/u)
    // A wrapped group starts a line, so its leading rule would show as a lone bar.
    expect(tail).toMatch(/\.pager \.sep,\s*\.marks > \.sep,\s*\.split > \.sep \{\s*display: none/u)
    const dock = block(sheets.Dock, '@media (max-width: 480px)')
    expect(block(dock, '.remove')).toMatch(/width: 44px;[\s\S]*height: 44px;/u)
    expect(block(dock, '.item')).toMatch(/min-height: 44px/u)
  })

  it('drop button labels in a narrow Chat column while keeping the glyphs', () => {
    const narrow = block(sheets.TailActions, '@container (max-width: 735px)')
    expect(block(narrow, '.label')).toMatch(/display: none/u)
    expect(block(narrow, '.pill')).toMatch(/width: calc\(28px/u)
  })

  it('keep the mark labels at their full width on devices that do not hover, after the narrow-column rule', () => {
    const sheet = sheets.TailActions
    const noHover = block(sheet, '@media (hover: none)')
    expect(sheet.indexOf('@media (hover: none)')).toBeGreaterThan(sheet.indexOf('@container (max-width: 735px)'))
    expect(block(noHover, '.marks .label')).toMatch(/display: inline/u)
    expect(block(noHover, '.marks .pill')).toMatch(/width: auto;[\s\S]*padding: 6px 8px;/u)
  })

  it('stack each Compare row into a card in a narrow tab and keep the table headers readable by assistive technology', () => {
    const narrow = block(sheets.CompareView, '@container (max-width: 720px)')
    expect(block(narrow, '.row {')).toMatch(/grid-template-areas:[\s\S]*'\. steps cost wall'/u)
    expect(block(narrow, '.head')).toMatch(/clip-path: inset\(50%\)/u)
    expect(narrow).not.toMatch(/\.head \{[^}]*display: none/u)
    expect(block(narrow, '.cellLabel')).toMatch(/display: block/u)
    expect(block(sheets.CompareDetail, '@container (max-width: 720px)')).toMatch(/grid-template-columns: minmax\(0, 1fr\)/u)
  })

  it('give the Compare controls 44px targets at phone width', () => {
    const phone = block(sheets.CompareView, '@media (max-width: 480px)')
    expect(block(phone, '.mark')).toMatch(/min-width: 44px;[\s\S]*height: 44px;/u)
    expect(block(block(sheets.CompareView, '@container (max-width: 720px)'), '.markLabel')).toMatch(/display: inline/u)
    expect(block(sheets.CompareView, '.markLabel')).toMatch(/display: none/u)
    expect(block(phone, '.radio')).toMatch(/width: 24px/u)
    expect(block(sheets.CompareDetail, '@media (max-width: 480px)')).toMatch(/min-height: 44px/u)
    expect(block(sheets.IsolationRow, '@media (max-width: 480px)')).toMatch(/min-height: 44px/u)
  })

  it('lay the Loom tab out as a toolbar above one panel', () => {
    expect(block(sheets.LoomView, '.root {')).toMatch(/grid-template-rows: auto minmax\(0, 1fr\)/u)
    expect(block(sheets.LoomView, '.comparePane')).toMatch(/overflow-y: auto/u)
  })
})
