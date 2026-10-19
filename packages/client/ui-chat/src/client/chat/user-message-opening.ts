/** Which user-authored Chat Node opened its Turn. */
import type { ChatConversationViewNode } from '../contract/chat-nodes.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'

/**
 * Whether a user-authored Chat Node opened its Turn: it was admitted before or
 * in the Turn's first step, and no loaded `user` or `steering` Node precedes
 * it in the Turn. The scan over the Turn's ordered keys ends at the first
 * user-authored key, so at the latest at the Node itself.
 * @param snapshot - current Chat publication.
 * @param node - a `user` or `steering` Chat Node.
 * @returns true for the Turn's opening user-authored message.
 */
export function userMessageOpensTurn(snapshot: ChatSnapshot, node: ChatConversationViewNode): boolean {
  const location = node.location
  if (location.kind !== 'turn' && (location.kind !== 'step' || location.step.step !== 1)) return false
  for (const key of snapshot.locations.getTurn(location.turn.turn)) {
    const kind = snapshot.nodes.get(key)?.kind
    if (kind === 'user' || kind === 'steering') return key === node.key
  }
  return false
}
