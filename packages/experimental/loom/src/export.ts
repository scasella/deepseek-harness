/** Authenticated, bounded Loom document downloads with curation and source attribution. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { deriveEventMessage, foldSurface, pluginRecordOf, type SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { inspectSession } from './inspect.ts'
import { ownLoomRecords } from './records.ts'
import { loomMarkRecordSchema } from './projection.ts'
import { forkFamily } from './family.ts'
import { readWeaveDocument } from './weave-records.ts'
import type { LoomExportRequest, LoomExportValue, LoomWeaveNode } from './types.ts'

/** Limits for retained download snapshots. */
export interface LoomExportConfig {
  /** Largest complete encoded download in bytes. Default 16777216. */
  readonly maxBytes?: number
  /** Largest retained immutable download count; oldest snapshots are evicted first. Default 64. */
  readonly maxDownloads?: number
  /** Download lifetime in milliseconds. Default 300000. */
  readonly ttlMs?: number
}

interface Download {
  readonly sessionId: SessionId
  readonly body: Uint8Array
  readonly filename: string
  readonly mimeType: string
  readonly expires: number
}

/** Escape prose and JSON embedded as plain HTML text. */
function htmlText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/** Session-owned downloadable snapshots; exact fetch routes are owner-authenticated by Connection. */
export class LoomExporter {
  private readonly downloads = new Map<string, Download>()
  private readonly pending = new Set<Promise<LoomExportValue>>()
  private connectionOwner: AbortController | undefined
  private available = false

  /**
   * @param ctx - Loom Host context owning the optional Connection route.
   * @param config - validated byte, item and expiry limits.
   */
  constructor(private readonly ctx: Context, private readonly config: Required<LoomExportConfig>) {
    ctx.inject(['connection'], (connectionCtx) => {
      const owner = new AbortController()
      this.connectionOwner = owner
      this.available = true
      connectionCtx.effect(() => connectionCtx.connection.fetch.register({
        path: '/api/loom.export', methods: ['GET', 'HEAD'], requestBody: 'buffered',
        fetch: request => Promise.resolve(this.fetch(request)),
      }), 'loom.export.route')
      connectionCtx.effect(() => async () => {
        this.available = false
        owner.abort()
        this.downloads.clear()
        await Promise.allSettled(this.pending)
      }, 'loom.export.snapshots')
    })
  }

  /**
   * Create an immutable download from only the Sessions the current caller may read.
   * @param request - focused path, sibling set or kept branches and output format.
   * @param canReach - current Remote action's Session authorization.
   * @param signal - cancellation while reading history.
   * @returns the owner-authenticated URL and download metadata.
   */
  async create(request: LoomExportRequest, canReach: (id: SessionId) => boolean, signal: AbortSignal): Promise<LoomExportValue> {
    const owner = this.connectionOwner
    if (!this.available || owner === undefined) throw this.unavailable(request.sessionId, 'This Host has no download connection.')
    const task = this.snapshot(request, canReach, AbortSignal.any([signal, owner.signal]))
      .catch((error: unknown) => {
        if (owner.signal.aborted) throw this.unavailable(request.sessionId, 'The download connection closed before this export was ready. Request the export again.')
        throw error
      }).finally(() => { this.pending.delete(task) })
    this.pending.add(task)
    return task
  }

  private async snapshot(request: LoomExportRequest, canReach: (id: SessionId) => boolean, signal: AbortSignal): Promise<LoomExportValue> {
    const format = request.format ?? 'json'
    const focused = await inspectSession(this.ctx, request.sessionId, signal)
    const document = readWeaveDocument(focused.events)
    let value: unknown
    let text: string
    if (request.nodeId !== undefined) {
      const focus = document.state.nodes.find(node => node.id === request.nodeId)
      if (focus === undefined) throw new RemoteError('loom/node-not-found', 'Select a recorded prose node to export.', { sessionId: request.sessionId, nodeId: request.nodeId })
      let nodes: readonly LoomWeaveNode[]
      if (request.mode === 'path') nodes = [focus]
      else if (request.mode === 'siblings') nodes = document.state.nodes.filter(node => node.requestSeq === focus.requestSeq)
      else nodes = document.state.nodes.filter(node => document.state.choices.some(choice => choice.nodeId === node.id))
      value = { sessionId: request.sessionId, mode: request.mode, nodes, choices: document.state.choices,
        curationBits: document.state.curationBits, modelTokens: document.state.modelTokens }
      text = nodes.map(node => node.prefix.map(span => span.text).join('') + node.text).join('\n\n---\n\n')
    } else {
      const listed = await this.ctx.sessionController.list({}, signal)
      const source = listed.items.find(item => item.sessionId === request.sessionId)
      const family = forkFamily(listed.items.filter(item => canReach(item.sessionId)).map(item => ({
        sessionId: item.sessionId, updatedAt: item.updatedAt, running: item.running, blank: item.blank,
        ...item.parentSessionId === undefined ? {} : { forkParentId: item.parentSessionId },
      })), request.sessionId)
      const siblings = listed.items.filter(item => canReach(item.sessionId)
        && (item.sessionId === request.sessionId || (item.parentSessionId === (source?.parentSessionId ?? request.sessionId)
          && (source?.parentSessionId === undefined
            || item.projections?.values.forkLineage?.cutSeq === source.projections?.values.forkLineage?.cutSeq))))
      const selected = request.mode === 'path' ? [request.sessionId]
        : request.mode === 'kept' ? family?.nodes.map(node => node.sessionId) ?? [] : siblings.map(item => item.sessionId)
      const sessions: { sessionId: SessionId; messages: unknown; events: unknown }[] = []
      const prose: string[] = []
      for (const sessionId of selected) {
        const inspected = sessionId === request.sessionId ? focused : await inspectSession(this.ctx, sessionId, signal)
        if (request.mode === 'kept') {
          const mark = inspected.events.slice(inspected.inheritedEventCount).map(pluginRecordOf).findLast(record => record?.type === 'plugin:loom/mark')
          if (mark?.type !== 'plugin:loom/mark' || loomMarkRecordSchema.safeParse(mark.data).data?.mark !== 'keep') continue
        }
        const surface = foldSurface(inspected.events, this.ctx.sessions.messageProjections)
        const messages = surface.nodes.flatMap((seq) => {
          const event = inspected.events[seq]
          /* v8 ignore next -- foldSurface only returns sequences of existing events */
          if (event === undefined) throw new Error('A surface event is missing from the inspected log')
          const message = deriveEventMessage(event, surface.projectedMessages)
          return message === null ? [] : [message]
        })
        sessions.push({ sessionId, messages, events: inspected.events })
        prose.push(messages.map(message => `${message.role}: ${message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')}`).join('\n\n'))
      }
      value = { sessionId: request.sessionId, mode: request.mode, sessions,
        curation: document.state.choices, curationBits: document.state.curationBits, modelTokens: document.state.modelTokens,
        adopted: ownLoomRecords(focused.events, focused.inheritedEventCount).adopted }
      text = prose.join('\n\n---\n\n')
    }
    signal.throwIfAborted()
    const json = JSON.stringify(value, null, 2)
    const curation = `Curation: ${String(document.state.curationBits)} bits; ${String(document.state.modelTokens)} selected model tokens.`
    const serialized = format === 'json' ? `${json}\n` : format === 'text' ? `${text}\n\n${curation}\n\n${json}\n`
      : `<!doctype html><meta charset="utf-8"><title>Loom export</title><main><pre>${htmlText(text)}</pre><p>${htmlText(curation)}</p><details><summary>Curation and source records</summary><pre>${htmlText(json)}</pre></details></main>\n`
    const body = new TextEncoder().encode(serialized)
    if (body.byteLength > this.config.maxBytes) throw this.unavailable(request.sessionId, 'The selected export exceeds the configured byte limit. Export a smaller path.')
    const extension = format === 'text' ? 'txt' : format
    const filename = `loom-${request.sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.${extension}`
    const mimeType = format === 'json' ? 'application/json' : format === 'text' ? 'text/plain' : 'text/html'
    this.prune()
    while (this.downloads.size >= this.config.maxDownloads) {
      const first = this.downloads.keys().next().value
      /* v8 ignore next -- maxDownloads is positive, so the loop owns an oldest snapshot */
      if (first === undefined) break
      this.downloads.delete(first)
    }
    const token = randomUUID()
    this.downloads.set(token, { sessionId: request.sessionId, body, filename, mimeType, expires: Date.now() + this.config.ttlMs })
    return { url: `/api/loom.export?token=${encodeURIComponent(token)}`, filename, mimeType }
  }

  private fetch(request: Request): Response {
    this.prune()
    const token = new URL(request.url).searchParams.get('token')
    const download = token === null ? undefined : this.downloads.get(token)
    if (download === undefined) return new Response('This Loom download expired. Request the export again.', { status: 404 })
    return new Response(request.method === 'HEAD' ? null : download.body.slice(), { headers: {
      'Content-Type': `${download.mimeType}; charset=utf-8`, 'Content-Length': String(download.body.byteLength),
      'Content-Disposition': `attachment; filename="${download.filename}"`, 'Cache-Control': 'no-store',
    } })
  }

  private prune(): void {
    const now = Date.now()
    for (const [token, download] of this.downloads) if (download.expires <= now) this.downloads.delete(token)
  }

  private unavailable(sessionId: SessionId, reason: string): RemoteError<'loom/export-unavailable'> {
    return new RemoteError('loom/export-unavailable', reason, { sessionId, reason })
  }
}
