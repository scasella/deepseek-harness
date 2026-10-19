/** Browser entry for the optional `loom` Remote contribution and Loom registrations. */
import type { Context } from '@deepseek-ai/cordis'
import loomRemote from '@deepseek-ai/dsh-experimental-loom/remote'
import { mountLoom } from './mount.ts'

export { inject } from './mount.ts'
export type { LoomFamilyState } from './family.ts'
export type { ForkBandProps } from './ForkBand.tsx'
export type { LoomLinkInjected } from './links.ts'
export type { LoomKey } from './locales.ts'
export type { LoomViewInjected, LoomViewProps } from './LoomView.tsx'
export type { LoomReaderDocument, LoomReaderState, LoomReaderTurn } from './reader.ts'
export type { LoomRequestState } from './requests.ts'
export type { VariantChipProps } from './VariantChip.tsx'
export type { LoomViewState } from './view-store.ts'

/**
 * Activate the experimental Loom contribution.
 * @param ctx - Client runtime.
 * @returns complete registration and Remote disposer.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountLoom(ctx, loomRemote)
}
