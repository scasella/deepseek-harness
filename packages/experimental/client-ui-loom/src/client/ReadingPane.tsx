/**
 * Read-only document of one Session's path: the inherited part collapsed to a
 * two-line preview, the cut, then each loaded own turn with its prompt, what
 * the model saw, its closing reasoning collapsed with the turn's reasoning
 * tokens, and its reply.
 */
import { useMemo, useState } from 'react'
import {
  DisclosureRow, IconBranchOutlineRegular, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular,
  IconThinkOutlineRegular, MarkdownText, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { LoomFamily } from '@deepseek-ai/dsh-experimental-loom/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TurnOutlineEntry } from '@deepseek-ai/dsh-session-turn-outline/client'
import { ClippedText } from './clipped.tsx'
import { cutReading, exactCount, plainPreview, plural, type LoomTranslate } from './format.ts'
import {
  branchOf, forkCutOf, inheritedCounts, inheritedSplitOf, lastInheritedTurnOf, ownCounts, projectionValuesOf, sessionTitle,
  variantsOf, type LoomCounts, type LoomSplit,
} from './lineage.ts'
import type { LoomViewProps } from './LoomView.tsx'
import type { LoomReaderTurn, LoomTurnUsage } from './reader.ts'
import { loomRequestKey } from './requests.ts'
import { TokenText } from './TokenText.tsx'
import css from './ReadingPane.module.css'

/** Props the view hands its reading pane. */
export interface ReadingPaneProps extends Pick<LoomViewProps,
  'useSessions' | 'useLoomReader' | 'useLoomRequest' | 'renderFactorySlot' | 'openSession' | 'loadOlder'> {
  readonly family: LoomFamily
  /** Session the pane reads. */
  readonly sessionId: SessionId
  /** Session the Loom tab belongs to. */
  readonly currentSessionId: SessionId
  readonly t: LoomTranslate
}

const THINK_ICON = <IconThinkOutlineRegular size={14} />

/** Own and inherited figures of the read Session, from its statistics. */
interface PaneCounts {
  readonly own: LoomCounts | undefined
  readonly inherited: LoomCounts | undefined
}

/**
 * Whether a loaded turn belongs to the Session itself rather than its inherited prefix.
 * @param turn - loaded turn.
 * @param split - where the Session's inherited prefix ends, or undefined for a Session without one.
 * @param lastInheritedTurn - last turn opened before the cut, including a turn the cut interrupted.
 * @returns whether the turn is the Session's own.
 */
function ownTurn(turn: LoomReaderTurn, split: LoomSplit | undefined, lastInheritedTurn: number): boolean {
  if (split === undefined) return true
  return turn.startSeq === undefined ? turn.turn > lastInheritedTurn : turn.startSeq > split.cutSeq
}

/**
 * Render the path document of one Session.
 * @param props - family, read Session, hooks, factories, navigation, and copy.
 * @returns the document.
 */
export function ReadingPane(props: ReadingPaneProps) {
  const { family, sessionId, currentSessionId, useSessions, useLoomReader, openSession, t } = props
  const list = useSessions(state => state)
  const reader = useLoomReader(sessionId)
  const values = projectionValuesOf(list, sessionId)
  // Own and inherited turns split as Chat folds them, for every origin; only a fork's cut names a branch.
  const split = inheritedSplitOf(values)
  const cut = forkCutOf(list, sessionId)
  const variants = useMemo(() => variantsOf(family, list, sessionId), [family, list, sessionId])
  const title = sessionTitle(list, sessionId)
  const parentTitle = cut === undefined ? undefined : list.byId[cut.parentId]?.displayTitle
  const outline = values?.turnOutline ?? []
  const inheritedOutline = split === undefined ? [] : outline.filter(entry => entry.seq <= split.cutSeq)
  const counts = useMemo<PaneCounts>(() => ({ own: ownCounts(values), inherited: inheritedCounts(values) }), [values])
  // A cut inside a turn inherits that turn's start, so the outline names it; `cutTurn` names only completed turns.
  const lastInheritedTurn = split === undefined ? 0 : lastInheritedTurnOf(values, split)

  return (
    <article className={css.document} data-loom-reader={sessionId}>
      <header className={css.head}>
        <h2 className={css.title}>{title}</h2>
        {branchOf(values)?.adopted === true && <Tag tone="success">{t('read.adopted')}</Tag>}
        {sessionId !== currentSessionId && (
          <button
            type="button"
            className={css.openButton}
            aria-label={t('read.openAria', { title })}
            onClick={() => { openSession(sessionId) }}
          >
            {t('read.open')}
          </button>
        )}
      </header>
      {split !== undefined && <InheritedSpan entries={inheritedOutline} steps={counts.inherited?.steps} split={split} t={t} />}
      {cut !== undefined && (
        <p className={css.cut}>
          <IconBranchOutlineRegular size={14} className={css.cutIcon} />
          <span>
            {t(parentTitle === undefined ? 'band.branched' : 'band.from')}
            {parentTitle !== undefined && <span className={css.parent}> {parentTitle}</span>}
            {' '}{cutReading(cut.cutTurn, inheritedOutline.at(-1)?.turn, t)}
            {variants !== undefined && variants.members.length > 1
              && <>{t('sep')}{t('read.variantOf', { index: variants.index, count: variants.members.length })}</>}
          </span>
        </p>
      )}
      {reader === undefined || reader.status === 'loading'
        ? <p className={css.status} role="status">{t('read.loading')}</p>
        : reader.status === 'failed'
          ? <p className={css.status} role="alert">{t('read.failed')}</p>
          : (
            <OwnTurns
              {...props}
              turns={reader.document.turns.filter(turn => ownTurn(turn, split, lastInheritedTurn))}
              hasMore={reader.document.hasMore}
              firstOwnTurn={lastInheritedTurn + 1}
              counts={counts}
            />
          )}
    </article>
  )
}

/** The inherited prefix collapsed to the first prompt and the last response. */
function InheritedSpan({ entries, steps, split, t }: {
  entries: readonly TurnOutlineEntry[]
  steps: number | undefined
  split: LoomSplit
  t: LoomTranslate
}) {
  const [open, setOpen] = useState(false)
  const first = entries[0]
  const last = entries.at(-1)
  const turns = entries.length === 1 && first !== undefined
    ? t('read.inheritedTurn', { turn: first.turn })
    : entries.length > 1 ? t('read.inheritedTurns', { count: entries.length })
      : split.cutTurn === undefined ? undefined : t('read.inheritedTurn', { turn: split.cutTurn })
  const heading = [
    t('read.inherited'),
    turns,
    steps === undefined ? undefined : t(`tree.steps.${plural(steps)}`, { count: steps }),
  ].filter(part => part !== undefined).join(t('sep'))
  return (
    <section className={css.inherited}>
      <button type="button" className={css.inheritedToggle} aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        {open ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
        <span>{heading}</span>
      </button>
      {!open && first !== undefined && last !== undefined && (
        <dl className={css.preview}>
          <dt>{t('read.you')}</dt>
          <ClippedText as="dd" text={plainPreview(first.prompt)} />
          <dt>{t('read.agent')}</dt>
          <ClippedText as="dd" text={plainPreview(last.response)} />
        </dl>
      )}
      {open && (
        <ol className={css.inheritedTurns}>
          {entries.map(entry => (
            <li key={entry.turn}>
              <span className={css.turnLabel}>{t('read.turn', { turn: entry.turn })}</span>
              <dl className={css.preview}>
                <dt>{t('read.you')}</dt>
                <dd>{plainPreview(entry.prompt)}</dd>
                <dt>{t('read.agent')}</dt>
                <dd>{plainPreview(entry.response)}</dd>
              </dl>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

/** The loaded own turns, with a way to page in earlier ones. */
function OwnTurns(props: ReadingPaneProps & {
  turns: readonly LoomReaderTurn[]
  hasMore: boolean
  firstOwnTurn: number
  counts: PaneCounts
}) {
  const { sessionId, turns, hasMore, firstOwnTurn, loadOlder, t } = props
  const earlierHidden = hasMore && (turns[0] === undefined || turns[0].turn > firstOwnTurn)
  return (
    <>
      {earlierHidden && (
        <p className={css.status}>
          {t('read.earlierHidden')}
          <button type="button" className={css.linkButton} onClick={() => { loadOlder(sessionId) }}>{t('read.loadEarlier')}</button>
        </p>
      )}
      {turns.length === 0 && !earlierHidden && <p className={css.status}>{t('read.noOwnTurns')}</p>}
      {turns.map(turn => <OwnTurnCard key={turn.turn} {...props} turn={turn} />)}
    </>
  )
}

/** One own turn: prompt, what the model saw, reasoning, and reply. */
function OwnTurnCard({ turn, counts, sessionId, useLoomRequest, renderFactorySlot, t }: ReadingPaneProps & {
  turn: LoomReaderTurn
  counts: PaneCounts
}) {
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const labels = useMemo(() => ({
    code: {
      copyLabel: t('copy'),
      copiedLabel: t('copied'),
      toolbarLabels: { codeLabel: t('codeBlock.title'), wrapLabel: t('codeBlock.wrap'), unwrapLabel: t('codeBlock.unwrap') },
    },
    footnotes: t('markdown.footnotes'),
  }), [t])
  const reasoningCount = turn.reasoningTokens === undefined
    ? undefined
    : t(`reasoning.tokens.${plural(turn.reasoningTokens)}`, { count: turn.reasoningTokens })
  return (
    <section className={css.turn} aria-label={t('read.turn', { turn: turn.turn })}>
      {turn.prompt !== '' && <div className={css.prompt}>{turn.prompt}</div>}
      {turn.closingSeq !== undefined && (
        <RequestDisclosure
          requestKey={loomRequestKey(sessionId, turn.closingSeq)}
          turn={turn.turn}
          usage={turn.usage}
          counts={counts}
          useLoomRequest={useLoomRequest}
          t={t}
        />
      )}
      {turn.reasoning !== '' && (
        <DisclosureRow
          className={css.reasoning}
          icon={THINK_ICON}
          title={t('reasoning.title')}
          open={reasoningOpen}
          expandable
          expandOnRowClick
          keepContentWhenOpen
          onToggle={() => { setReasoningOpen(value => !value) }}
          collapsedContent={reasoningCount === undefined ? undefined : <span className={css.reasoningCount}>{reasoningCount}</span>}
        >
          {reasoningOpen && renderFactorySlot('conversation.chat.reasoning.content', { text: turn.reasoning, running: false })}
        </DisclosureRow>
      )}
      {turn.reply === ''
        ? <p className={css.status}>{t(turn.closed ? 'read.noReply' : 'read.running')}</p>
        : <div className={css.reply}><MarkdownText text={turn.reply} labels={labels} /></div>}
      {turn.capturedReply !== undefined && <details><summary>{t('token.inspector')}</summary><p>{t('token.legend')}</p>
        {turn.capturedReply.map((block, index) => <p key={index}><TokenText {...block} t={t} /></p>)}
      </details>}
    </section>
  )
}

/** Facts of one turn that the request view does not carry. */
interface TurnFacts {
  requestKey: string
  turn: number
  /** The turn's own reported usage. */
  usage: LoomTurnUsage | undefined
  counts: PaneCounts
}

/** "What the model saw" for one turn's closing request, read when opened. */
function RequestDisclosure(props: Pick<ReadingPaneProps, 'useLoomRequest' | 't'> & TurnFacts) {
  const { t } = props
  const [open, setOpen] = useState(false)
  return (
    <section className={css.saw}>
      <button type="button" className={css.sawToggle} aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        {open ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
        <span>{t('saw.title')}</span>
      </button>
      {open && <RequestFacts {...props} />}
    </section>
  )
}

/**
 * Name a failed request read.
 * @param code - typed Remote failure code, or undefined when the call itself failed.
 * @param t - Loom translate seat.
 * @returns the failure line.
 */
function failureLine(code: string | undefined, t: LoomTranslate): string {
  switch (code) {
    case undefined: return t('saw.unavailable')
    case 'session/not-found': return t('saw.notFound')
    case 'loom/seq-out-of-range': return t('saw.outOfRange')
    case 'remote-access/denied': return t('saw.denied')
    default: return t('saw.failed', { code })
  }
}

/**
 * Name one side's turns, with its steps when they describe the same span.
 * @param turns - turns the request saw on that side.
 * @param counts - the Session's figures for that side, when reported.
 * @param t - Loom translate seat.
 * @returns the chip value.
 */
function sideReading(turns: number, counts: LoomCounts | undefined, t: LoomTranslate): string {
  const reading = t(`saw.turns.${plural(turns)}`, { count: turns })
  // Session figures grow with later turns; they match the request only while the turn counts agree.
  return counts === undefined || counts.turns !== turns
    ? reading
    : [reading, t(`tree.steps.${plural(counts.steps)}`, { count: counts.steps })].join(t('sep'))
}

/**
 * Read one turn's own usage line.
 * @param usage - the turn's reported usage.
 * @param t - Loom translate seat.
 * @returns "Own turn usage: N new input · N cached · N output tokens".
 */
function usageLine(usage: LoomTurnUsage, t: LoomTranslate): string {
  const parts = [
    t('saw.usage.input', { count: exactCount(usage.inputTokens, t) }),
    usage.cachedTokens === undefined ? undefined : t('saw.usage.cached', { count: exactCount(usage.cachedTokens, t) }),
    t('saw.usage.output', { count: exactCount(usage.outputTokens, t) }),
  ].filter(part => part !== undefined).join(t('sep'))
  return t('saw.usage', { parts })
}

/** Chips of one request view. */
function RequestFacts({ requestKey, turn, usage, counts, useLoomRequest, t }: Pick<ReadingPaneProps, 'useLoomRequest' | 't'> & TurnFacts) {
  const state = useLoomRequest(requestKey)
  if (state === undefined || state.status === 'loading') return <p className={css.status} role="status">{t('saw.loading')}</p>
  if (state.status === 'failed') {
    return (
      <p className={css.status} role="alert">
        {failureLine(state.code, t)}
      </p>
    )
  }
  const { view } = state
  const inheritedMessages = view.messages.filter(message => message.inherited).length
  const route = [view.route.provider, view.route.model, view.route.reasoningEffort].filter(part => part !== undefined).join(t('sep'))
  const tools = [
    t(`saw.tools.${plural(view.tools.names.length)}`, { count: view.tools.names.length }),
    view.tools.addedThisTurn.length === 0 ? undefined : t('saw.toolsAdded', { count: view.tools.addedThisTurn.length }),
    view.tools.removedThisTurn.length === 0 ? undefined : t('saw.toolsRemoved', { count: view.tools.removedThisTurn.length }),
  ].filter(part => part !== undefined).join(t('sep'))
  const system = [
    t('saw.systemChars', { count: exactCount(view.systemPrompt.chars, t) }),
    view.systemPrompt.changedAtTurn === turn ? t('saw.rebuilt', { turn }) : undefined,
  ].filter(part => part !== undefined).join(t('sep'))
  return (
    <div className={css.facts}>
      <ul className={css.chips}>
        <li className={css.chip}><span className={css.chipName}>{t('saw.system')}</span><span>{system}</span></li>
        <li className={css.chip}><span className={css.chipName}>{tools}</span></li>
        <li className={css.chip}>
          <span className={css.chipName}>{t('saw.inherited')}</span>
          <span>{sideReading(view.inheritedTurns, counts.inherited, t)}</span>
        </li>
        <li className={css.chip}>
          <span className={css.chipName}>{t('saw.own')}</span>
          <span>{sideReading(view.ownTurns, counts.own, t)}</span>
        </li>
      </ul>
      {usage !== undefined && <p className={css.line}>{usageLine(usage, t)}</p>}
      <p className={css.messages}>
        <span className={css.messageCount}>
          {t(`saw.messages.${plural(view.messages.length)}`, { count: view.messages.length, inherited: inheritedMessages })}
        </span>
        <span aria-hidden="true">{t('sep')}</span>
        <ClippedText text={t('saw.routeLine', { route })} className={css.route} />
      </p>
    </div>
  )
}
