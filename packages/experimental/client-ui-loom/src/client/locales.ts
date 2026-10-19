/** Loom Web dictionaries. */

/** Locale namespace owned by the Loom Web UI. */
export const NS = 'loom'

/** Simplified Chinese dictionary and key source. */
export const zh = {
  'view.loom': '织机',
  'family.loading': '正在加载分叉家族…',
  'family.unavailable': '分叉家族暂不可用',
} satisfies Record<string, string>

/** Loom locale key union. */
export type LoomKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  'view.loom': 'Loom',
  'family.loading': 'Loading fork family…',
  'family.unavailable': 'Fork family is unavailable',
} satisfies Record<LoomKey, string>
