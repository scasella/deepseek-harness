// @vitest-environment jsdom
/** A View with a side column insets the overlay composer; the shell clears the inset when the View changes or unmounts. */
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConvViewOwnerProps, ConversationSessionSlotProps } from '../src/client/contract/slots.ts'
import { DefaultConversationViews } from '../src/client/skeleton/DefaultConversationViews.tsx'

afterEach(() => { cleanup() })

/** Mount the shell's View area inside a scrollport and expose the owner props each View receives. */
function mount(initialView: string) {
  const owners: ConvViewOwnerProps[] = []
  const selected = createSnapshotStore<{ view: string | null; viewRequest: null }>({ view: initialView, viewRequest: null })
  // Only the members the View area reads are stubbed.
  const props: ConversationSessionSlotProps = {
    view: undefined,
    useSession: bindSnapshotSelector(createSnapshotStore({
      blank: false, awaitingFirstTurn: false, running: false, promptAttempted: true,
    })),
    useConversation: bindSnapshotSelector(createSnapshotStore({ activeTargets: new Set(['chat']) })),
    useConversationViews: bindSnapshotSelector(createSnapshotStore([{ id: 'chat', label: 'Chat' }, { id: 'loom', label: 'Loom' }])),
    useInspectCall: bindSnapshotSelector(createSnapshotStore(undefined)),
    useStore: bindSnapshotSelector(selected),
    actions: { setDraft: vi.fn(), completeViewRequest: vi.fn() },
    inputActions: { persistDraft: vi.fn() },
    bindDraftPersistence: () => () => {},
    openView: vi.fn(),
    renderSlot: (_name: string, owner: ConvViewOwnerProps, options: { only: string }): ReactNode => {
      owners.push(owner)
      return <div data-view={options.only} />
    },
  } as never
  const view = render(<div data-conversation-scroll=""><DefaultConversationViews {...props} /></div>)
  const scroller = view.container.querySelector<HTMLElement>('[data-conversation-scroll]')!
  const inset = (): string => scroller.style.getPropertyValue('--dsh-composer-inset-start')
  return { view, owners, selected, inset }
}

describe('composer inset', () => {
  it('writes the inset a View reports and clears it when the View changes or unmounts', () => {
    const { view, owners, selected, inset } = mount('loom')
    act(() => { owners.at(-1)!.insetComposerStart(340) })
    expect(inset()).toBe('340px')
    act(() => { owners.at(-1)!.insetComposerStart(0) })
    expect(inset()).toBe('')
    act(() => { owners.at(-1)!.insetComposerStart(300) })
    act(() => { selected.set({ view: 'chat', viewRequest: null }) })
    expect(inset()).toBe('')
    act(() => { owners.at(-1)!.insetComposerStart(120) })
    expect(inset()).toBe('120px')
    const scroller = view.container.querySelector<HTMLElement>('[data-conversation-scroll]')!
    view.unmount()
    expect(scroller.style.getPropertyValue('--dsh-composer-inset-start')).toBe('')
  })
})
