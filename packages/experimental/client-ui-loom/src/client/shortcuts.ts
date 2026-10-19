/**
 * Shortcut reference rows of the Loom family tree. The tree handles its keys
 * itself while a row has focus; these fixed rows list them in the shortcut
 * reference under the `tree` group and reserve them against editable
 * bindings.
 */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ShortcutBinding, ShortcutCommandId, ShortcutFixedCommand, Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { LoomTranslate } from './format.ts'

/** One row: its id suffix, label key, and physical keys. */
const ROWS = [
  { id: 'move', label: 'keys.fixed.move', bindings: [{ code: 'ArrowUp', modifiers: [] }, { code: 'ArrowDown', modifiers: [] }] },
  { id: 'collapse-expand', label: 'keys.fixed.collapseExpand', bindings: [{ code: 'ArrowLeft', modifiers: [] }, { code: 'ArrowRight', modifiers: [] }] },
  { id: 'open', label: 'keys.fixed.open', bindings: [{ code: 'Enter', modifiers: [] }] },
  { id: 'branch', label: 'keys.fixed.branch', bindings: [{ code: 'KeyG', modifiers: [] }] },
  { id: 'keep', label: 'keys.fixed.keep', bindings: [{ code: 'KeyK', modifiers: [] }] },
  { id: 'set-aside', label: 'keys.fixed.setAside', bindings: [{ code: 'KeyX', modifiers: [] }] },
] as const satisfies readonly { id: string; label: string; bindings: readonly [ShortcutBinding, ...ShortcutBinding[]] }[]

/**
 * Describe the tree's fixed rows.
 * @param shortcuts - the shortcut registry, which renders each binding's keycaps.
 * @param t - Loom translate seat.
 * @returns one fixed command per tree key group.
 */
export function loomTreeCommands(shortcuts: Pick<Shortcuts, 'describeBinding'>, t: LoomTranslate): readonly ShortcutFixedCommand[] {
  return ROWS.map(row => ({
    id: brandString<ShortcutCommandId>(`loom.tree.${row.id}`),
    label: () => t(row.label),
    keys: row.bindings.flatMap(binding => shortcuts.describeBinding(binding).keys),
    bindings: row.bindings,
    group: 'tree',
  }))
}

/**
 * Register the tree's fixed rows on a fiber that holds the shortcut registry.
 * @param scope - fiber injecting `shortcuts`; disposing it removes the rows.
 * @param t - Loom translate seat.
 */
export function registerLoomTreeKeys(scope: Context, t: LoomTranslate): void {
  for (const command of loomTreeCommands(scope.shortcuts, t)) {
    scope.effect(() => scope.shortcuts.registerFixed(command), `client-ui-loom: ${command.id}`)
  }
}
