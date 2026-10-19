/** Props shared by the Loom entries in the composer's input dock. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { LoomBranchingInjected } from './links.ts'
import type { NS } from './locales.ts'

/** Full props of a `conversation.input.dock` Loom entry. */
export type LoomDockProps =
  PropsRuntime<'conversation.input.dock'> & InjectFace<LoomBranchingInjected> & PropsLocale<typeof NS>
