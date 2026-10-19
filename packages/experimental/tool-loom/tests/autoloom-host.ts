/**
 * Host composition for autoloom specs: the real agent loop, Session store,
 * projection registry, token meter, Session query, Remote access, Session
 * Controller, and Loom service, each mounted as a plugin, plus stand-ins for
 * the Workspace registry and the permission presets, a routed model adapter,
 * and the autoloom tools.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, type AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import type { AttachmentAdmissionPart, ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import Loom, { type Config as LoomConfig } from '@deepseek-ai/dsh-experimental-loom'
import {
  createUserMessage,
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { PresetSpec } from '@deepseek-ai/dsh-permission-presets'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as SessionStats from '@deepseek-ai/dsh-session-stats'
import type { ToolResult } from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { vi, type Mock } from 'vitest'
import * as ToolLoom from '../src/index.ts'

const IMAGE_LIMITS: ImageAttachmentLimits = Object.freeze({
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageDimension: 2000,
  mediaTypes: Object.freeze(['image/png'] as const),
})

/** Point reads only; these specs never search. */
class PointSessionQuery extends SessionQuery {
  searchSessions(): never { throw new Error('Unexpected full-text Session search') }
  searchEvents(): never { throw new Error('Unexpected full-text event search') }
}

/** One scripted reply: chunks to stream, or `hang` to stream nothing until the request is cancelled. */
export type Reply = readonly StreamChunk[] | 'hang'

/**
 * A text reply with explicit usage.
 * @param text - the reply text.
 * @param usage - provider-reported usage.
 * @returns the reply's chunks.
 */
export function textReply(
  text: string,
  usage: { inputTokens: number; outputTokens: number } = { inputTokens: 10, outputTokens: 5 },
): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * A reply that calls one tool.
 * @param id - tool call id.
 * @param name - tool name.
 * @param args - tool arguments.
 * @param usage - provider-reported usage.
 * @returns the reply's chunks.
 */
export function toolReply(id: string, name: string, args: object, usage = { inputTokens: 10, outputTokens: 5 }): StreamChunk[] {
  const block = { type: 'tool-call' as const, id: ToolCallId(id), name, arguments: JSON.stringify(args) }
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments },
    { type: 'block-end', index: 0, block },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Text of the last user message of a request. */
export function lastUserText(options: GenerateOptions): string {
  return (options.messages.findLast(message => message.role === 'user')?.content ?? [])
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** Answers each request through `respond`, which tests replace; the default echoes the last user text. */
export class RoutedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  respond: (options: GenerateOptions) => Reply = options => textReply(`reply: ${lastUserText(options)}`)

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'mock', name: 'mock' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const reply = this.respond(options)
    if (reply === 'hang') {
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    yield * reply
  }
}

/** Stand-in permission presets: the named specs, and `set` writes the preset event. */
export class TestPresets {
  readonly specs: Record<string, PresetSpec> = {
    auto: { sandbox: 'read-only', approval: 'never' },
    'loom-child': { sandbox: 'read-only', approval: 'never' },
    'read-only': { sandbox: 'read-only', approval: 'ask' },
  }

  get names(): readonly string[] {
    return Object.keys(this.specs)
  }

  resolve(name: string): PresetSpec {
    const spec = this.specs[name]
    if (spec === undefined) throw new Error(`permission: unknown preset "${name}"`)
    return spec
  }

  set(session: Session, name: string): void {
    session.append('permission/preset', { preset: name })
  }
}

/** The mounted composition. */
export interface AutoloomHost {
  readonly ctx: Context
  readonly agents: AgentLoopTestHarness
  readonly adapter: RoutedAdapter
  readonly presets: TestPresets
  /** Sessions the Workspace registry archived, in call order. */
  readonly archived: SessionId[]
  /** The Workspace registry's archive method. */
  readonly archiveSession: Mock<(sessionId: SessionId, options?: { readonly stopActivity?: boolean }) => Promise<void>>
  /** The autoloom tool plugin fiber. */
  readonly tools: ReturnType<Context['plugin']>
}

/**
 * Mount the composition on `ctx`; the default route is `mock`.
 * @param ctx - fresh root Context the caller disposes.
 * @param config - autoloom tool configuration.
 * @param loomConfig - Loom service configuration.
 * @returns the composition.
 */
export async function mountAutoloomHost(ctx: Context, config: ToolLoom.Config = {}, loomConfig: LoomConfig = {}): Promise<AutoloomHost> {
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(SessionStats)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(PointSessionQuery, {})
  const agents = await mountAgentLoopTestHarness(ctx)
  const archived: SessionId[] = []
  const archiveSession = vi.fn((sessionId: SessionId, _options?: { readonly stopActivity?: boolean }) => {
    archived.push(sessionId)
    return Promise.resolve()
  })
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: archived, archiveSession } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }), saveSelection: async () => {} } as never)
  ctx.provide('attachments', {
    imageLimits: IMAGE_LIMITS,
    admitPromptContent: async (content: readonly AttachmentAdmissionPart[]) => content,
  } as never)
  ctx.provide('fileUploads', {
    registerAgentResolver: () => () => {},
    resolve: () => undefined,
    bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
  } as never)
  ctx.provide('fs', {} as never)
  const presets = new TestPresets()
  ctx.provide('permissionPresets', presets as never)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(SessionController, { nativeOpen: false })
  await ctx.plugin(Loom, loomConfig)
  const adapter = new RoutedAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const tools = ctx.plugin(ToolLoom, config)
  await tools
  return { ctx, agents, adapter, presets, archived, archiveSession, tools }
}

/**
 * Run one prompt to whole-agent idle.
 * @param agent - the Agent.
 * @param text - the prompt.
 */
export async function run(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

let callCount = 0

/**
 * Execute one autoloom tool directly, as the agent loop would for `agent`.
 * @param host - the composition.
 * @param agent - the calling Agent, or undefined for a call without one.
 * @param name - tool name.
 * @param args - tool arguments.
 * @param options - an explicit call id and cancellation.
 * @returns the tool result.
 */
export function call(
  host: AutoloomHost,
  agent: Agent | undefined,
  name: string,
  args: object,
  options: { readonly callId?: string; readonly signal?: AbortSignal } = {},
): Promise<ToolResult> {
  callCount += 1
  return host.ctx.tools.execute({
    callId: ToolCallId(options.callId ?? `autoloom-call-${String(callCount)}`),
    name,
    arguments: args,
    signal: options.signal ?? new AbortController().signal,
    ...agent === undefined ? {} : { agent },
  })
}

/**
 * Text of a tool result.
 * @param result - the result.
 * @returns its text blocks joined.
 */
export function textOf(result: ToolResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/**
 * Parse a successful JSON tool result.
 * @param result - the result.
 * @returns the canonical value.
 * @throws Error when the call failed.
 */
export function valueOf(result: ToolResult): unknown {
  if (result.isError) throw new Error(`tool failed: ${textOf(result)}`)
  return JSON.parse(textOf(result))
}
