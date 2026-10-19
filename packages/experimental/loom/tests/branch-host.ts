/**
 * Host composition for branch specs: the real agent loop, Session store,
 * projection registry, Session query, Remote access, and Session Controller,
 * each mounted as a plugin so that services reach each other the way the
 * product composition does, plus the Loom service.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, type AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import type { AttachmentAdmissionPart, ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Loom, { type Config } from '../src/index.ts'

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

/** A Workspace the fork attaches its child to. */
export interface TestWorkspace {
  readonly id: string
  readonly path: string
  readonly sessionIds: readonly SessionId[]
  attachSession(sessionId: SessionId): Promise<void>
}

/** One archive request the Workspace registry stand-in received. */
export interface TestArchive {
  readonly sessionId: SessionId
  readonly stopActivity: boolean
}

/** The mounted composition. */
export interface BranchHost {
  readonly agents: AgentLoopTestHarness
  /** Workspaces the Session Controller's fork reads; edits apply to the next fork. */
  readonly workspaces: TestWorkspace[]
  /** Archive requests in call order; `fail` rejects the next request for that Session. */
  readonly archives: { readonly calls: TestArchive[]; readonly archived: SessionId[]; fail?: SessionId }
  /** The Loom plugin fiber. */
  readonly loom: ReturnType<Context['plugin']>
}

/**
 * Mount the composition on `ctx`. Register the model adapter before calling
 * Loom methods; prompt attachments are admitted as given.
 * @param ctx - fresh root Context the caller disposes.
 * @param defaultModel - the deployment default route.
 * @param config - Loom configuration.
 * @param persistenceRoot - directory of a JSONL Session store to mount before the agent loop, so that Sessions
 *   outlive their Agents; without it, Sessions live in memory only.
 * @param filesystem - `local` mounts the local filesystem and the working-directory service, which worktrees
 *   need; `stub` provides an empty filesystem that only the Session Controller's injection reads.
 * @returns the agent driver, the Workspace list, the archive requests, and the Loom fiber.
 */
export async function mountBranchHost(
  ctx: Context,
  defaultModel: ModelSelection,
  config: Config = {},
  persistenceRoot?: string,
  filesystem: 'stub' | 'local' = 'stub',
): Promise<BranchHost> {
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: filesystem === 'local' })
  // The store mounts before the loop so that teardown drains live Agents into still-open handles.
  if (persistenceRoot !== undefined) await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(PointSessionQuery, {})
  const agents = await mountAgentLoopTestHarness(ctx)
  const workspaces: TestWorkspace[] = []
  const archives: BranchHost['archives'] = { calls: [], archived: [] }
  ctx.provide('workspaceRegistry', {
    list: () => workspaces,
    get archivedSessionIds() { return archives.archived },
    archiveSession: async (sessionId: SessionId, options: { readonly stopActivity?: boolean } = {}) => {
      archives.calls.push({ sessionId, stopActivity: options.stopActivity === true })
      if (archives.fail === sessionId) throw new Error(`archive of ${sessionId} failed`)
      if (!archives.archived.includes(sessionId)) archives.archived.push(sessionId)
    },
  } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => defaultModel, saveSelection: async () => {} } as never)
  ctx.provide('attachments', {
    imageLimits: IMAGE_LIMITS,
    admitPromptContent: async (content: readonly AttachmentAdmissionPart[]) => content,
  } as never)
  ctx.provide('fileUploads', {
    registerAgentResolver: () => () => {},
    resolve: () => undefined,
    bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
  } as never)
  if (filesystem === 'stub') ctx.provide('fs', {} as never)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(SessionController, { nativeOpen: false })
  const loom = ctx.plugin(Loom, config)
  await loom
  return { agents, workspaces, archives, loom }
}
