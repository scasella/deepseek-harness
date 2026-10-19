/** Ordered Chat rows, local echoes, and running status share the flow slot's parent. */
import { memo, useCallback } from 'react'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ChatFlowSlotProps } from '../contract/slots.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { ChatGroupSeat } from './ChatGroupSeat.tsx'
import { InheritedSpanRow } from './InheritedSpanRow.tsx'
import { FORK_CUT_SEAT_KEY, INHERITED_ROW_KEY } from './inherited-span.ts'
import { PendingSteeringBubble, PendingSubmissionBubble } from './MessageItem.tsx'
import { chatRenderKey } from './render-entry.ts'
import { RunningStatus } from './RunningStatus.tsx'
import css from './ChatView.module.css'

/**
 * Render the flow without adding a DOM parent or changing keyed row positions.
 * In a fork, the inherited entries stay mounted under searchable hiding behind
 * one disclosure row, and the fork-cut Seat follows them.
 */
export const ChatFlow = memo(function ChatFlow({
  entries, pendingInputs, lastInputTurn, deferCollapse, forkCut,
  useSession, useChat, useChatNode, useChatNodeBottom, useChatNodeProcess, useChatGroup, usePresentation,
  useStore, actions, renderSlot, renderFactorySlot, t, useGroupAction, useGroupHeaderAction,
  cwd, openFile, inspectCall, forkAt, loadImage, fileMentions,
}: ChatFlowSlotProps) {
  const nodeStore = useChat(snapshot => snapshot.nodes)
  const running = useSession(snapshot => snapshot.running)
  const latestTurnAnchor = useChat(snapshot => snapshot.navigation.items().at(-1)?.anchorKey)
  const runningStartTime = useChatNode(latestTurnAnchor ?? '', (node) => {
    const location = node?.location
    return location?.kind === 'turn' || location?.kind === 'step'
      ? location.turn.status === 'open' ? location.turn.start?.time : undefined
      : undefined
  })
  const seatProps = {
    nodeStore, useChatNode, useChatNodeBottom, useChatNodeProcess, usePresentation,
    useStore, actions, renderSlot, t, useGroupAction, deferCollapse,
    cwd, openFile, inspectCall, forkAt, loadImage, fileMentions,
  }
  const inheritedTurn = forkCut?.owner.inheritedTurn
  const inheritedEntries = forkCut?.inheritedEntries ?? 0
  const folded = inheritedTurn !== undefined && inheritedEntries > 0
  const inheritedHidden = folded && forkCut?.owner.inheritedOpen === false
  // Browser find or focus inside a hidden inherited row expands the span.
  const revealInherited = useCallback(() => { actions.setInheritedOpen(true) }, [actions])
  const rows = entries.map((entry, index) => {
    const inherited = inheritedHidden && index < inheritedEntries ? { revealInherited } : {}
    switch (entry.kind) {
      case 'node':
        return <ChatNodeSeat {...seatProps} {...inherited} key={chatRenderKey(entry)} nodeKey={entry.key}
          {...entry.groupPart === undefined ? {} : { groupPart: entry.groupPart }} />
      case 'group':
        return <ChatGroupSeat {...seatProps} {...inherited} key={chatRenderKey(entry)} groupKey={entry.key}
          useChatGroup={useChatGroup} useGroupHeaderAction={useGroupHeaderAction} />
      default:
        return assertNever(entry)
    }
  })
  const pendingRows = pendingInputs.map(item => 'requestId' in item ? (
    <PendingSubmissionBubble key={item.requestId} submission={item}
      loadImage={loadImage} renderFactorySlot={renderFactorySlot} t={t} />
  ) : (
    <PendingSteeringBubble key={item.id} content={item.content}
      loadImage={loadImage} renderFactorySlot={renderFactorySlot} t={t} />
  ))
  const tail = entries.at(-1)
  const node = tail?.kind === 'node' ? nodeStore.get(tail.key) : undefined
  // An empty opening control follows one local transcript echo, never steering.
  // All rows share this keyed list so inserting the control keeps the echo mounted.
  if (node?.kind === 'turn-process' && node.location.kind === 'turn'
    && node.location.turn.status === 'open' && node.location.turn.turn !== lastInputTurn) {
    const index = pendingInputs.findIndex(item => 'requestId' in item && item.placement === 'transcript')
    if (index !== -1) rows.splice(rows.length - 1, 0, ...pendingRows.splice(index, 1))
  }
  if (forkCut !== undefined) {
    rows.splice(inheritedEntries, 0, (
      <div key={FORK_CUT_SEAT_KEY} className={css.flowItem} data-chat-flow-kind="fork-cut">
        {renderSlot('conversation.chat.fork-cut', forkCut.owner)}
      </div>
    ))
    if (folded) {
      rows.unshift(<InheritedSpanRow key={INHERITED_ROW_KEY} turn={inheritedTurn} steps={forkCut.inheritedSteps}
        open={forkCut.owner.inheritedOpen} onToggle={forkCut.toggle} t={t} />)
    }
  }
  return [...rows, ...pendingRows, ...running ? [<RunningStatus key="running" startTime={runningStartTime} t={t} />] : []]
})
