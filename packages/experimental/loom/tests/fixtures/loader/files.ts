/** Files the Loom Loader fixture writes in its working directory, and their line types. */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** One agent-loop request per line, as `llm/stream` listeners receive it before route projection. */
export const REQUEST_LOG = 'loom-requests.jsonl'

/** The driver's findings after its last request settles. */
export const REPORT = 'loom-report.json'

/** One line of {@link REQUEST_LOG}. */
export interface LoggedRequest {
  readonly sessionId: string | undefined
  readonly provider: string
  readonly model: string
  readonly toolNames: readonly string[]
  readonly messages: GenerateOptions['messages']
}
