/** Props shared by the Loom entries in the completed Turn's action row after Branch. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { LoomBranchingInjected } from './links.ts'
import type { NS } from './locales.ts'

/** Full props of a `conversation.chat.assistant-actions.after` Loom entry. */
export type LoomTailProps =
  PropsRuntime<'conversation.chat.assistant-actions.after'> & InjectFace<LoomBranchingInjected> & PropsLocale<typeof NS>
