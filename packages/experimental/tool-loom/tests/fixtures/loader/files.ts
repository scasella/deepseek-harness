/** Files the autoloom Loader fixture writes in its working directory. */

/** The driver's findings after the weaver's turn settles. */
export const REPORT = 'autoloom-report.json'

/** One child the weaver started, as the driver read it. */
export interface ReportedChild {
  readonly sessionId: string
  readonly parentSession: string | undefined
  /** Own event types in log order. */
  readonly ownTypes: readonly string[]
  /** Source of the child's first own prompt. */
  readonly source: unknown
  /** Current private mark, or null. */
  readonly mark: string | null
  /** The child's permission preset after the weaver's preparation. */
  readonly preset: string
}

/** The report file. */
export interface AutoloomLoaderReport {
  readonly entries: readonly { readonly id: string; readonly active: boolean }[]
  readonly storyId: string
  /** Own-content matches from the shipped profile's bundle-enabled search. */
  readonly searched: readonly string[]
  readonly weaverId: string
  readonly toolNames: readonly string[]
  readonly weaverCalls: readonly string[]
  /** The weaver's tool results, each serialized and cut to 400 characters. */
  readonly weaverResults: readonly string[]
  readonly children: readonly ReportedChild[]
  readonly archived: readonly string[]
}
