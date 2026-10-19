// Seeding and replay inputs shared by the Loom branching Web specs.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { SESSION_FORMAT_VERSION, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'

/** Recorded single-call Session whose header-rewritten copies serve as replayed Loom children. */
const BASE_FIXTURE = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v3.jsonl', import.meta.url))

/** Text of the recorded reply every replayed Loom child receives. */
export const CHILD_REPLY = 'Event sourcing is a pattern'

/**
 * Open a turn the way the agent loop logs one that a queued user prompt
 * opened: the prompt is inserted into and spliced out of the next-turn queue
 * around `turn/start`, then admitted as the turn's first `user/message`.
 * Without these splices the Host refuses regenerate and edit with
 * `not-user-opened`.
 */
function openTurn(session: Session, turn: number, prompt: string, title: string): void {
  const message = createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
  session.append('turn/start', { turn })
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  session.append('step/start', { turn, step: 1 })
  if (session.snapshotEvents().every(event => event.type !== 'system/message')) {
    session.append('system/message', { turn, step: 1, message: createSystemMessage('Synthetic Loom branching system prompt.') }, { surfaceOp: 'append' })
  }
  const user = session.append('user/message', message, { surfaceOp: 'append' })
  if (session.snapshotEvents().every(event => event.type !== 'session/title')) {
    session.append('session/title', { title, messageSeqs: [user.seq], source: { kind: 'fallback' } })
    session.append('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }, reason: 'initial' })
  }
}

/** Append one assistant text reply with usage that grows with the turn. */
function answerStep(session: Session, turn: number, step: number, answer: string): void {
  session.append('assistant/message', {
    stream: [],
    turn,
    step,
    message: createAssistantMessage({
      content: [{ type: 'text', text: answer }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
    usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 3_000 * turn, totalTokens: 1_200 + 3_000 * turn },
  }, { surfaceOp: 'append' })
}

/**
 * Append one closed one-step turn that a queued user prompt opened.
 * @param session - the Session to extend.
 * @param turn - the turn number.
 * @param prompt - text of the opening user prompt.
 * @param answer - text of the assistant reply.
 * @param title - the Session title the first turn records.
 */
export function appendOpenedTurn(session: Session, turn: number, prompt: string, answer: string, title: string): void {
  openTurn(session, turn, prompt, title)
  answerStep(session, turn, 1, answer)
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/**
 * Append one closed two-step turn whose second step admitted a steering
 * message: the message waits in the next-step queue during step 1 and is
 * claimed, as a `user/message`, when step 2 starts.
 * @param session - the Session to extend.
 * @param turn - the turn number.
 * @param prompt - text of the opening user prompt.
 * @param steer - text of the steering message.
 * @param answers - assistant replies of step 1 and step 2.
 * @param title - the Session title the first turn records.
 */
export function appendSteeredTurn(
  session: Session,
  turn: number,
  prompt: string,
  steer: string,
  answers: readonly [string, string],
  title: string,
): void {
  openTurn(session, turn, prompt, title)
  const steering = createUserMessage({ content: [{ type: 'text', text: steer }], source: { kind: 'user' } })
  session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [steering] })
  answerStep(session, turn, 1, answers[0])
  session.append('step/end', { turn, step: 1 })
  session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] })
  session.append('step/start', { turn, step: 2 })
  session.append('user/message', steering, { surfaceOp: 'append' })
  answerStep(session, turn, 2, answers[1])
  session.append('step/end', { turn, step: 2 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/**
 * Render a Session as a seed fixture: the header with the cwd and id tokens
 * the scaffold fills in, then one JSON line per event.
 * @param session - the template Session.
 * @param createdAt - creation time of the seeded root.
 * @returns fixture text for `seedForkFamily`.
 */
export function seedFixtureText(session: Session, createdAt: number): string {
  return [
    JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)),
    '',
  ].join('\n')
}

/**
 * Write the replay inputs for Loom children: a header-only primary whose
 * whole-script override hangs once, and header-rewritten copies of the recorded
 * single-call fixture for the later children.
 * @param dir - directory that receives the files.
 * @param readyFile - file the hang creates when a child has reached the model.
 * @param childCount - copies of the recorded fixture to write.
 * @returns the primary, override and child fixture paths.
 */
export async function writeReplayInputs(
  dir: string,
  readyFile: string,
  childCount: number,
): Promise<{ primary: string; override: string; children: string[] }> {
  const primary = join(dir, 'session.jsonl')
  const override = join(dir, 'replay.override.json')
  await writeFile(primary, '{"type":"session","version":0,"id":"primary","createdAt":0}\n')
  await writeFile(override, JSON.stringify([{ kind: 'hang', readyFile }]))
  const [header, ...events] = (await readFile(BASE_FIXTURE, 'utf8')).trimEnd().split('\n')
  if (header === undefined) throw new Error('base replay fixture has no header')
  const children: string[] = []
  for (let index = 0; index < childCount; index += 1) {
    const childHeader = JSON.parse(header) as Record<string, unknown>
    childHeader.id = `recorded-loom-child-${String(index)}`
    childHeader.createdAt = 1784998084442 + index
    const path = join(dir, `child-${String(index)}.jsonl`)
    await writeFile(path, [JSON.stringify(childHeader), ...events, ''].join('\n'))
    children.push(path)
  }
  return { primary, override, children }
}
