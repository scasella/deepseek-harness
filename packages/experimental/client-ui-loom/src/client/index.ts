/** Browser entry for the optional `loom` Remote contribution and Loom registrations. */
import type { Context } from '@deepseek-ai/cordis'
import loomRemote from '@deepseek-ai/dsh-experimental-loom/remote'
import { mountLoom } from './mount.ts'

export { inject } from './mount.ts'
export type { LoomFamilyState } from './family.ts'
export type { LoomKey } from './locales.ts'

/**
 * Activate the experimental Loom contribution.
 * @param ctx - Client runtime.
 * @returns complete registration and Remote disposer.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountLoom(ctx, loomRemote)
}
