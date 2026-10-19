/** Browser entry for the optional `loom` Remote contribution and Loom registrations. */
import type { Context } from '@deepseek-ai/cordis'
import loomRemote from '@deepseek-ai/dsh-experimental-loom/remote'
import { mountLoom } from './mount.ts'

export { inject } from './mount.ts'
export type {
  LoomBranchDraft, LoomBranchForm, LoomBranchingState, LoomFailure, LoomMarkOverride, LoomOutcome, LoomTrackedChild,
  LoomTrackedSet, LoomValueOutcome,
} from './branching.ts'
export type { CompareDetailProps } from './CompareDetail.tsx'
export type { CompareViewProps } from './CompareView.tsx'
export type { LoomReadState } from './read-sources.ts'
export type { LoomDockProps } from './dock.ts'
export type { EditBranchProps } from './EditBranch.tsx'
export type { LoomFamilyState } from './family.ts'
export type { ForkBandProps } from './ForkBand.tsx'
export type { LoomBranchingInjected, LoomLinkInjected } from './links.ts'
export type { LoomKey } from './locales.ts'
export type { LoomViewInjected, LoomViewProps } from './LoomView.tsx'
export type { LoomReaderDocument, LoomReaderState, LoomReaderTurn } from './reader.ts'
export type { LoomRequestState } from './requests.ts'
export type { LoomRouteOption, LoomRoutesState } from './routes.ts'
export type { LoomTailProps } from './tail.ts'
export type { VariantChipProps } from './VariantChip.tsx'
export type { LoomProseDraft, LoomViewMode, LoomViewState } from './view-store.ts'
export type { LoomWorkspace } from './workspace.ts'
export type { MultiverseInjected, MultiversePageProps } from './MultiversePage.tsx'
export type { MultiverseSearchRequest, MultiverseSearchValue } from './multiverse.ts'
export type { LoomProseCalls, LoomProseInjected } from './prose.ts'
export type { WeaveViewProps } from './WeaveView.tsx'
export type { CounterfactualActionProps, CounterfactualInjected } from './CounterfactualAction.tsx'
export type { TokenTextProps } from './TokenText.tsx'
export type { AutoloomCardProps, AutoloomCardValue } from './AutoloomCard.tsx'

/**
 * Activate the experimental Loom contribution.
 * @param ctx - Client runtime.
 * @returns complete registration and Remote disposer.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountLoom(ctx, loomRemote)
}
