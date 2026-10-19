/** Join CSS Module class names, skipping absent and false entries. */

/**
 * Join class names.
 * @param names - class names, or false/undefined for a condition that does not apply.
 * @returns the space-separated class list.
 */
export function classes(...names: readonly (string | false | undefined)[]): string {
  return names.filter(name => typeof name === 'string' && name !== '').join(' ')
}
