/** Prose generation, counterfactual tool output, and export wire values. */
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AssistantStreamRecord, BlockTokenLogprobs, LlmCallConfig, TextBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { LoomNodeId } from './types.ts'

/** A content-only tool-result branch request. */
export interface LoomCounterfactualRequest {
  readonly sessionId: SessionId
  readonly resultSeq: SessionSeq
  readonly content: readonly TextBlock[]
}

/** New branch and the replacement it recorded before continuing. */
export interface LoomCounterfactualValue {
  readonly sessionId: SessionId
  readonly replacementSeq: SessionSeq
}

/** Attribution of the tool-result content a counterfactual child replaced. */
export interface LoomToolResultOverrideRecord {
  readonly version: 1
  readonly sourceSessionId: SessionId
  readonly resultSeq: SessionSeq
  readonly replacementSeq: SessionSeq
}

/** An authored span of the exact prose prefix sent to a model. */
export interface LoomPrefixSpan {
  readonly text: string
  readonly author: 'user' | 'model' | 'alternative'
  /** Required for model-authored text; identifies a node containing this span. */
  readonly node?: LoomNodeId
  /** Captured token position for an alternative span. */
  readonly tokenIndex?: number
}

/** Generation controls resolved against the deployment's prose defaults. */
export interface LoomWeaveControls {
  readonly maxTokens?: number
  readonly temperature?: number
  readonly topLogprobs?: number
  readonly stop?: readonly string[]
}

/** Generate sibling prose continuations at one document cursor. */
export interface LoomWeaveRequest {
  readonly sessionId: SessionId
  readonly parent: LoomNodeId | null
  readonly prefix: readonly LoomPrefixSpan[]
  readonly n: number
  readonly controls?: LoomWeaveControls
  readonly route?: ModelSelection
}

/** Exact auxiliary request, persisted before any sibling dispatch. */
export interface LoomWeaveRequestRecord {
  readonly version: 1
  readonly parentNode: LoomNodeId | null
  readonly n: number
  readonly config: LlmCallConfig
  readonly topLogprobs: number
  readonly system: string
  readonly messages: readonly { readonly role: 'user'; readonly content: readonly TextBlock[] }[]
  readonly assistantPrefix: string
  readonly prefixSpans: readonly LoomPrefixSpan[]
  readonly stop: readonly string[]
  readonly schedule: 'lead-then-burst' | 'burst'
  readonly kind: 'weave' | 'probe'
}

/** One settled sibling's exact compact stream, including failure settlement. */
export interface LoomWeaveNodeRecord {
  readonly version: 1
  readonly id: LoomNodeId
  readonly requestSeq: SessionSeq
  readonly index: number
  readonly kind: 'weave' | 'probe'
  readonly stream: readonly AssistantStreamRecord[]
}

/** A settled prose continuation and its captured probabilities. */
export interface LoomWeaveNode {
  readonly id: LoomNodeId
  readonly parent: LoomNodeId | null
  readonly requestSeq: SessionSeq
  readonly index: number
  readonly kind: 'weave' | 'probe'
  /** Exact authored prefix at this node's cursor, retained across reloads and partial cuts. */
  readonly prefix: readonly LoomPrefixSpan[]
  readonly text: string
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly usage?: TokenUsage
  readonly logprobs?: BlockTokenLogprobs
  readonly error?: string
  /** Provider-neutral failure code; error text is retained for diagnostics. */
  readonly failureCode?: string
}

/** Siblings in deterministic dispatch order after every sibling settles. */
export interface LoomWeaveValue {
  readonly requestSeq: SessionSeq
  readonly schedule: 'lead-then-burst' | 'burst'
  readonly nodes: readonly LoomWeaveNode[]
}

/** One choice within a settled sibling set; a later choice in that set supersedes it. */
export interface LoomChoiceRecord {
  readonly version: 1
  readonly nodeId: LoomNodeId
  readonly requestSeq: SessionSeq
  readonly alternatives: number
}

/** Select one generated prose node. */
export interface LoomChooseRequest {
  readonly sessionId: SessionId
  readonly nodeId: LoomNodeId
}

/** Information retained by current prose choices, independent of agent-branch adoptions. */
export interface LoomCurationValue {
  readonly curationBits: number
  readonly modelTokens: number
}

/** Read the persisted prose document and choices. */
export interface LoomWeaveStateRequest {
  readonly sessionId: SessionId
}

/** Persisted prose nodes and the last choice for each sibling set. */
export interface LoomWeaveState extends LoomCurationValue {
  readonly nodes: readonly LoomWeaveNode[]
  readonly choices: readonly LoomChoiceRecord[]
}

/** Explore captured next-token alternatives within deployment request limits. */
export interface LoomProbeRequest {
  readonly sessionId: SessionId
  readonly parent: LoomNodeId | null
  readonly prefix: readonly LoomPrefixSpan[]
  readonly route?: ModelSelection
  readonly depth?: number
  readonly cutoff?: number
}

/** One token alternative at a bounded probe position. */
export interface LoomProbeNode {
  readonly id: Branded<'LoomProbeNodeId'>
  readonly parent: Branded<'LoomProbeNodeId'> | null
  readonly token: string
  /** Recorded probe response whose alternatives contain this token. */
  readonly sourceNodeId: LoomNodeId
  readonly tokenIndex: number
  readonly probability: number
  readonly cumulativeProbability: number
  readonly depth: number
}

/** Completed bounded breadth-first probability exploration. */
export interface LoomProbeValue {
  readonly nodes: readonly LoomProbeNode[]
  readonly requests: number
  readonly truncated: boolean
  /** Positions actually sampled, including those with no alternatives above the cutoff. */
  readonly positions?: readonly { readonly parent: LoomProbeNode['id'] | null; readonly sourceNodeId: LoomNodeId }[]
}

/** Machine-readable prose refusal for localized recovery guidance. */
export type LoomProseUnavailableReason = 'unsupported-prefix' | 'unsupported-logprobs' | 'limits' | 'prefix' | 'route' | 'busy' | 'provider' | 'cancelled'

/** Download a prose path or agent-branch selection with its curation facts. */
export interface LoomExportRequest {
  readonly sessionId: SessionId
  readonly mode: 'path' | 'siblings' | 'kept'
  readonly nodeId?: LoomNodeId
  /** Default json. */
  readonly format?: 'html' | 'text' | 'json'
}

/** Authenticated download location; no file is written to the workspace. */
export interface LoomExportValue {
  readonly url: string
  readonly filename: string
  readonly mimeType: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Source attribution of a content-only tool-result replacement in a fork. */
    'plugin:loom/tool-result-override': LoomToolResultOverrideRecord
    /** Exact logged auxiliary prose request shared by its siblings. */
    'plugin:loom/weave-request': LoomWeaveRequestRecord
    /** A sibling's complete settled auxiliary stream. */
    'plugin:loom/weave-node': LoomWeaveNodeRecord
    /** Selection within one prose sibling set; does not change Chat history. */
    'plugin:loom/choice': LoomChoiceRecord
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'loom/counterfactual-unavailable': { readonly sessionId: SessionId; readonly resultSeq: SessionSeq }
    'loom/counterfactual-incomplete': { readonly sessionId: SessionId; readonly childSessionId: SessionId; readonly reason: string }
    'loom/prose-unavailable': { readonly sessionId: SessionId; readonly reason: string; readonly reasonCode?: LoomProseUnavailableReason }
    'loom/node-not-found': { readonly sessionId: SessionId; readonly nodeId: LoomNodeId }
    'loom/export-unavailable': { readonly sessionId: SessionId; readonly reason: string }
  }
}
