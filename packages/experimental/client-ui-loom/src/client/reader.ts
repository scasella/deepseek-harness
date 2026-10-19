/**
 * React-free reader sources keyed by Session id. While observed, a source
 * retains its Session, follows the Session's Chat target, and folds the loaded
 * turns into one read-only document: each turn's prompt, closing reply,
 * closing reasoning, and reported reasoning tokens and usage. The last unsubscribe
 * releases the Session and drops the source with its document. The view binds the sources as `useLoomReader(sessionId)`.
 */
import type { SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { notifySubscribers, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BlockTokenLogprobs } from '@deepseek-ai/dsh-llm/types'
import { keyedSourceRegistry, type KeyedLifecycle } from './keyed-sources.ts'

/** One loaded turn of the read Session. */
export interface LoomReaderTurn {
  readonly turn: number
  /** `turn/start` seq; absent when the loaded window starts inside the turn. */
  readonly startSeq?: number
  /** Text of the turn's opening user message, verbatim; empty for a turn another source started. */
  readonly prompt: string
  /** Text of the closing assistant message, verbatim. */
  readonly reply: string
  /** Answer text blocks with provider-captured probabilities; reasoning is excluded. */
  readonly capturedReply?: readonly { readonly text: string; readonly logprobs: BlockTokenLogprobs }[]
  /** Reasoning of the closing assistant message, verbatim. */
  readonly reasoning: string
  /** Reasoning tokens of every attempt in the turn; absent when any attempt did not report them. */
  readonly reasoningTokens?: number
  /** Token usage of every attempt in the turn; absent until the turn reports exact usage. */
  readonly usage?: LoomTurnUsage
  /** Seq of the closing `assistant/message`; absent until the turn settles a content-bearing reply. */
  readonly closingSeq?: number
  /** Whether the loaded window holds the turn's `turn/end`. */
  readonly closed: boolean
}

/** Token usage one turn reported across its attempts. */
export interface LoomTurnUsage {
  /** Uncached prompt input. */
  readonly inputTokens: number
  /** Prompt input served from cache; absent when any attempt did not report it. */
  readonly cachedTokens?: number
  readonly outputTokens: number
}

/** Loaded turns of one Session, oldest first. */
export interface LoomReaderDocument {
  readonly turns: readonly LoomReaderTurn[]
  /** Whether older history remains unloaded. */
  readonly hasMore: boolean
}

/** Read state of one Session. */
export type LoomReaderState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly document: LoomReaderDocument }

/** Session access supplied by the owning plugin. */
export interface LoomReaderInputs {
  /**
   * Retain a Session for reading.
   * @param sessionId - Session to read.
   * @returns an owned reference the source releases.
   */
  retain(sessionId: SessionId): SessionReference
  /**
   * Resolve the Chat target of a retained Session.
   * @param binding - current binding of the retained Session.
   * @returns the Chat target source.
   */
  chat(binding: SessionBinding): ObservableSnapshot<ChatSnapshot | undefined>
}

/** Keyed reader sources owned by one plugin fiber. */
export interface LoomReaderSources {
  /**
   * Return the source of one Session's document; a source dropped by its last
   * unsubscribe is replaced by a fresh one that reads again.
   * @param key - Session id.
   * @returns the source, stable while observed.
   */
  source(key: string): ObservableSnapshot<LoomReaderState>
  /** Release every retained Session. */
  dispose(): void
}

const LOADING: LoomReaderState = Object.freeze({ status: 'loading' })
const FAILED: LoomReaderState = Object.freeze({ status: 'failed' })

/** Whether two turns carry the same facts. */
function sameTurn(left: LoomReaderTurn, right: LoomReaderTurn): boolean {
  return left.turn === right.turn && left.startSeq === right.startSeq && left.prompt === right.prompt
    && left.reply === right.reply && left.reasoning === right.reasoning
    && left.reasoningTokens === right.reasoningTokens && left.closingSeq === right.closingSeq && left.closed === right.closed
    && left.usage?.inputTokens === right.usage?.inputTokens && left.usage?.cachedTokens === right.usage?.cachedTokens
    && left.usage?.outputTokens === right.usage?.outputTokens
    && left.capturedReply?.length === right.capturedReply?.length
    && (left.capturedReply ?? []).every((block, index) => {
      const other = (right.capturedReply as readonly typeof block[])[index] as typeof block
      return block.text === other.text && block.logprobs === other.logprobs
    })
}

/**
 * Fold a Chat snapshot into the loaded turns. Unchanged turns keep their
 * references, and an unchanged document returns `previous`.
 * @param chat - current Chat target snapshot.
 * @param hasMore - whether older history remains unloaded.
 * @param previous - the previously published document.
 * @returns the document.
 */
export function readerDocument(chat: ChatSnapshot, hasMore: boolean, previous?: LoomReaderDocument): LoomReaderDocument {
  const earlier = new Map(previous?.turns.map(turn => [turn.turn, turn]))
  const turns = chat.timeline.turnOrder.map((turn): LoomReaderTurn => {
    const location = chat.timeline.turns.get(turn)
    const [opening] = chat.nodes.turnDataSource(turn, 'user').getSnapshot()
    const tail = chat.nodes.turnDataSource(turn, 'turn-tail').getSnapshot().at(-1)
    const blocks = tail?.closing?.blocks ?? []
    const usage = tail?.tokenUsage
    const reasoningTokens = usage?.reasoningTokens
    const capturedReply = blocks.flatMap(block => block.kind === 'text' && block.logprobs !== undefined ? [{ text: block.text, logprobs: block.logprobs }] : [])
    const next: LoomReaderTurn = {
      turn,
      ...location?.start === undefined ? {} : { startSeq: location.start.seq },
      prompt: (opening?.content ?? []).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n\n'),
      reply: blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('\n\n'),
      ...capturedReply.length === 0 ? {} : { capturedReply },
      reasoning: blocks.flatMap(block => block.kind === 'reasoning' ? [block.text] : []).join('\n\n'),
      ...reasoningTokens === undefined ? {} : { reasoningTokens },
      ...usage === undefined ? {} : {
        usage: {
          inputTokens: usage.uncachedInputTokens,
          ...usage.cacheReadTokens === undefined ? {} : { cachedTokens: usage.cacheReadTokens },
          outputTokens: usage.outputTokens,
        },
      },
      ...tail?.closing == null ? {} : { closingSeq: tail.closing.finalNode.seq },
      closed: location?.status === 'closed',
    }
    const kept = earlier.get(turn)
    return kept !== undefined && sameTurn(kept, next) ? kept : next
  })
  if (previous?.hasMore === hasMore && previous.turns.length === turns.length
    && previous.turns.every((turn, index) => turn === turns[index])) return previous
  return { turns, hasMore }
}

/**
 * Create reader sources over retained Sessions.
 * @param inputs - Session retention and Chat target access.
 * @returns keyed sources; the caller disposes them with its fiber.
 */
export function createLoomReaderSources(inputs: LoomReaderInputs): LoomReaderSources {
  const sources = keyedSourceRegistry((key, lifecycle) => new ReaderSource(SessionId(key), inputs, lifecycle))
  return {
    source: key => sources.get(key),
    dispose() { sources.dispose() },
  }
}

/** One Session's document, folded while observed. */
class ReaderSource implements ObservableSnapshot<LoomReaderState> {
  private readonly listeners = new Set<() => void>()
  private state: LoomReaderState = LOADING
  /** Retention of the current observation; undefined while unobserved. */
  private reference: SessionReference | undefined
  private unsubscribeChat: (() => void) | undefined

  constructor(
    private readonly sessionId: SessionId,
    private readonly inputs: LoomReaderInputs,
    private readonly lifecycle: KeyedLifecycle,
  ) {}

  getSnapshot(): LoomReaderState { return this.state }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      this.lifecycle.active()
      this.open()
    }
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size > 0) return
      this.close()
      this.lifecycle.idle()
    }
  }

  close(): void {
    this.listeners.clear()
    this.unsubscribeChat?.()
    this.unsubscribeChat = undefined
    this.reference?.release()
    this.reference = undefined
  }

  /** Retain the Session and follow its Chat target once the initial open settles. */
  private open(): void {
    if (this.state.status === 'failed') this.state = LOADING
    const reference = this.inputs.retain(this.sessionId)
    this.reference = reference
    reference.ready.then((binding) => {
      if (this.reference !== reference) return
      const chat = this.inputs.chat(binding)
      const derive = (): void => {
        const snapshot = chat.getSnapshot()
        if (snapshot === undefined) return
        const previous = this.state.status === 'ready' ? this.state.document : undefined
        const document = readerDocument(snapshot, binding.eventSource.getSnapshot().hasMore, previous)
        if (document !== previous) this.publish({ status: 'ready', document })
      }
      this.unsubscribeChat = chat.subscribe(derive)
      derive()
    }).catch((_error: unknown) => {
      // The failure is shown as an unreadable Session; a later observation retries.
      if (this.reference !== reference) return
      this.publish(FAILED)
    })
  }

  private publish(state: LoomReaderState): void {
    this.state = state
    notifySubscribers(this.listeners, '[client-ui-loom] reader')
  }
}
