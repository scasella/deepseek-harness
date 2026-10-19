/**
 * React-free verbs on a branch's files and standing: adopt it as the main
 * line, apply its worktree change to the source folder, and discard its
 * worktree. The Host does the work, archives the other siblings of an adopted
 * branch itself, and never deletes a Session, so the browser only asks and
 * reads the outcome. Disposal stops the verbs' follow-up reads; a call in
 * flight still ends on the Host.
 */
import type {
  LoomAdoptRequest, LoomAdoptValue, LoomApplyRequest, LoomApplyValue, LoomDiscardRequest, LoomDiscardValue,
} from '@deepseek-ai/dsh-experimental-loom/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { settled, type LoomValueOutcome } from './branching.ts'

/** Remote calls and projection refresh supplied by the owning plugin. */
export interface LoomWorkspaceInputs {
  /** `loom.adopt`. */
  readonly adopt: (request: LoomAdoptRequest) => Promise<RemoteResult<LoomAdoptValue>>
  /** `loom.apply`. */
  readonly apply: (request: LoomApplyRequest) => Promise<RemoteResult<LoomApplyValue>>
  /** `loom.discard`. */
  readonly discard: (request: LoomDiscardRequest) => Promise<RemoteResult<LoomDiscardValue>>
  /** Read a Session's projections again, so an adopted marker reaches the list. */
  readonly refreshProjection: (sessionId: SessionId) => Promise<void>
}

/** Verbs on one branch's files and standing. */
export interface LoomWorkspace {
  /**
   * Adopt a branch as the main line: the Host records the choice in the branch and archives its running and ended
   * siblings, stopping a running one first. Nothing is deleted. The branch's projections are read again afterwards,
   * also after `loom/adopt-incomplete`, which fails only after the Host recorded the adoption.
   * @param sessionId - branch to adopt.
   * @returns the adopted Session and the siblings archived, or the failure.
   */
  adopt(sessionId: SessionId): Promise<LoomValueOutcome<LoomAdoptValue>>
  /**
   * Apply a worktree branch's change to the source folder, then remove that worktree.
   * @param sessionId - worktree branch.
   * @returns the applied files, or the failure: `loom/apply-dirty` and `loom/apply-conflict` name the paths in the way.
   */
  apply(sessionId: SessionId): Promise<LoomValueOutcome<LoomApplyValue>>
  /**
   * Remove the worktree the Loom service created for a branch; the Session and its log stay.
   * @param sessionId - worktree branch.
   * @returns the outcome.
   */
  discard(sessionId: SessionId): Promise<LoomValueOutcome<LoomDiscardValue>>
  /** Stop the follow-up projection reads. */
  dispose(): void
}

/**
 * Create the verbs of one plugin fiber.
 * @param inputs - Remote calls and projection refresh.
 * @returns the verbs; the caller disposes them with its fiber.
 */
export function createLoomWorkspace(inputs: LoomWorkspaceInputs): LoomWorkspace {
  let disposed = false
  return {
    async adopt(sessionId) {
      const outcome = await settled(inputs.adopt({ sessionId }))
      // The Host records the adoption before it archives siblings, so a partial archive still adopted the branch.
      const adopted = outcome.ok ? outcome.value.adopted : outcome.failure.code === 'loom/adopt-incomplete' ? sessionId : undefined
      if (adopted !== undefined && !disposed) {
        inputs.refreshProjection(adopted).catch((_error: unknown) => {
          // A failed read is recorded on the Session's projection snapshot; the marker arrives with its next frame.
        })
      }
      return outcome
    },
    apply: sessionId => settled(inputs.apply({ sessionId })),
    discard: sessionId => settled(inputs.discard({ sessionId })),
    dispose() { disposed = true },
  }
}
