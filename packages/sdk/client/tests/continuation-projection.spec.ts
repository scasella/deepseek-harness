/** SDK readers preserve continuation attribution on the existing turn event. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createProcessDeepSeekHarness } from '../src/api.ts'

it('retains turn continuation attribution in SDK results and notifications', async () => {
  const expected = JSON.parse(await readFile(new URL('./expected/continuation-projection.json', import.meta.url), 'utf8')) as {
    finalResponse: string
    turnStart: { data: { continuation: { kind: string; rpcId: string } } }
  }
  const harness = createProcessDeepSeekHarness({
    command: process.execPath, args: [fileURLToPath(new URL('./fake-runtime.ts', import.meta.url))],
    environment: () => ({
      ...process.env, FAKE_TEXT: expected.finalResponse,
      FAKE_CONTINUATION_SOURCE: JSON.stringify(expected.turnStart.data.continuation),
    }),
    description: 'scripted SDK continuation projection', initializeTimeoutMs: 5000,
  })
  try {
    const result = await harness.run('Observe the recorded turn.')
    const turnStart = result.events.find(event => event.type === 'turn/start')
    expect({ finalResponse: result.finalResponse, turnStart }).toEqual(expected)
    expect(result.notifications.find(notification => notification.method === 'session.event'
      && (notification.params.event as { type?: string }).type === 'turn/start')?.params.event).toEqual(turnStart)
  } finally {
    await harness.close()
  }
})
