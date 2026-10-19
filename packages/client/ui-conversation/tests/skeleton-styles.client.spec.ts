/** Stylesheet rules of the Conversation skeleton: the overlay composer inset and the crumb shrink order. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const conversationCss = readFileSync(fileURLToPath(new URL(
  '../src/client/skeleton/ConversationRoot.module.css',
  import.meta.url,
)), 'utf8')

describe('conversation skeleton styles', () => {
  it('offsets only the overlay composer seat by the View inset', () => {
    expect(conversationCss).toMatch(
      /\.scrollBody:has\(\[data-conversation-composer-overlay\]\) > \.composerSeat \{[^}]*left: var\(--dsh-composer-inset-start, 0px\);/s,
    )
  })

  it('shrinks ancestor crumbs before the current Session crumb', () => {
    expect(conversationCss).toMatch(/\.crumbSeg:not\(:last-child\) \{\s*flex: 0 100 auto;\s*min-width: 3em;\s*\}/)
    expect(conversationCss).toMatch(/\.crumbSeg:last-child \{\s*flex: 0 1 auto;\s*min-width: min\(55%, 12em\);\s*\}/)
    // A shrinking ancestor keeps its separator whole.
    expect(conversationCss).toMatch(/\.crumbSep \{[^}]*flex: none;/s)
  })
})
