/** Test summaries read from a Session's own command output text, never from tool metadata. */
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { compileTestSummary, DEFAULT_TEST_SUMMARY, ownTestOutcome } from '../src/outcomes.ts'
import type { LoomCommandTool, LoomTestSummaryPattern } from '../src/types.ts'

const TOOLS: readonly LoomCommandTool[] = [{ name: 'bash', commandArgument: 'command' }, { name: 'run', commandArgument: 'script' }]
const PATTERNS = compileTestSummary(DEFAULT_TEST_SUMMARY)

type Entry =
  | { readonly call: string; readonly name?: string; readonly args?: string }
  | { readonly result: string; readonly text: string | readonly string[]; readonly meta?: unknown }

function log(...entries: readonly Entry[]): SessionEvent[] {
  return entries.map((entry, seq) => {
    const data = 'call' in entry
      ? { turn: 1, step: 1, callId: ToolCallId(entry.call), name: entry.name ?? 'bash', arguments: entry.args ?? JSON.stringify({ command: `cmd-${entry.call}` }) }
      : {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: ToolCallId(entry.result),
          content: (typeof entry.text === 'string' ? [entry.text] : entry.text).map(text => ({ type: 'text', text })),
        },
        ...entry.meta === undefined ? {} : { meta: entry.meta },
      }
    return { type: 'call' in entry ? 'tool/call' : 'tool/result', data, seq: SessionSeq(seq), time: seq } as SessionEvent
  })
}

function outcome(events: readonly SessionEvent[], inherited = 0) {
  return ownTestOutcome(events, inherited, TOOLS, PATTERNS)
}

describe('default test summaries', () => {
  it.each([
    ['unittest OK', 'Ran 8 tests in 0.003s\n\nOK', { passed: 8, failed: 0, total: 8, ok: true }],
    ['unittest skips', 'Ran 3 tests in 0.001s\n\nOK (skipped=1)', { passed: 2, failed: 0, total: 3, ok: true }],
    ['unittest failures and errors', '..F\nRan 9 tests in 0.010s\n\nFAILED (failures=2, errors=1)', { passed: 6, failed: 3, total: 9, ok: false }],
    ['pytest bars', '================ 5 passed, 1 skipped in 0.12s ================', { passed: 5, failed: 0, total: 6, ok: true }],
    ['pytest quiet', 'F..\n1 failed, 2 passed, 1 error in 0.05s', { passed: 2, failed: 2, total: 4, ok: false }],
    ['pytest duration note', '=== 2 passed, 3 warnings in 1.50s (0:00:01) ===', { passed: 2, failed: 0, total: 2, ok: true }],
    ['vitest', ' Test Files  1 failed (1)\n      Tests  2 failed | 5 passed | 1 skipped (8)', { passed: 5, failed: 2, total: 8, ok: false }],
    ['vitest colors', '      \u001b[2mTests\u001b[22m  \u001b[1m\u001b[32m4 passed\u001b[39m\u001b[22m\u001b[90m (4)\u001b[39m', { passed: 4, failed: 0, total: 4, ok: true }],
    ['jest', 'Tests:       1 failed, 4 passed, 5 total', { passed: 4, failed: 1, total: 5, ok: false }],
    ['no tests', 'Ran 0 tests in 0.000s\n\nOK', { passed: 0, failed: 0, total: 0, ok: false }],
  ])('reads %s', (_name, text, counts) => {
    expect(outcome(log({ call: 'a' }, { result: 'a', text }))).toEqual({ ...counts, command: 'cmd-a' })
  })

  it('takes the last summary of the last command output that has one', () => {
    const events = log(
      { call: 'a' }, { result: 'a', text: '=== 1 passed in 0.1s ===' },
      { call: 'b' }, { result: 'b', text: ['Ran 2 tests in 0.1s\n\nOK', 'Tests:       3 passed, 3 total'] },
      { call: 'c' }, { result: 'c', text: 'build finished' },
    )
    expect(outcome(events)).toEqual({ passed: 3, failed: 0, total: 3, ok: true, command: 'cmd-b' })
  })

  it('prefers a summary that ends later in the output over an earlier pattern’s, and joins text parts only', () => {
    const later = log({ call: 'a' }, { result: 'a', text: 'Tests:       2 passed, 2 total\n=== 3 passed in 0.1s ===' })
    expect(outcome(later)).toMatchObject({ passed: 3, total: 3 })
    const earlier = log({ call: 'a' }, { result: 'a', text: '=== 3 passed in 0.1s ===\nTests:       2 passed, 2 total' })
    expect(outcome(earlier)).toMatchObject({ passed: 2, total: 2 })
    const mixed = log({ call: 'a' }, { result: 'a', text: 'Ran 1 test in 0.1s' })
    const result = mixed[1]!
    if (result.type !== 'tool/result') throw new Error('fixture')
    const parts = [...result.data.message.content, { type: 'tool-removal', toolName: 'other' }, { type: 'text', text: 'OK' }]
    mixed[1] = { ...result, data: { ...result.data, message: { ...result.data.message, content: parts } } } as SessionEvent
    expect(outcome(mixed)).toMatchObject({ passed: 1, total: 1, ok: true })
  })

  it('reads text only: metadata, other tools, inherited calls, and unanswered calls count for nothing', () => {
    const events = log(
      { call: 'inherited' },
      { result: 'inherited', text: '=== 7 passed in 0.1s ===' },
      { call: 'other', name: 'read_file' }, { result: 'other', text: '=== 9 passed in 0.1s ===' },
      { call: 'quiet' }, { result: 'quiet', text: 'no summary', meta: { stdout: { text: '=== 99 passed in 0.1s ===' } } },
      { result: 'orphan', text: '=== 4 passed in 0.1s ===' },
    )
    expect(outcome(events, 2)).toBeUndefined()
  })

  it('names the command from the configured argument, or the tool when the arguments hold none', () => {
    const summary = '=== 1 passed in 0.1s ==='
    expect(outcome(log({ call: 'a', name: 'run', args: '{"script":"make test"}' }, { result: 'a', text: summary }))?.command).toBe('make test')
    for (const args of ['not json', '"text"', 'null', '{"command":7}']) {
      expect(outcome(log({ call: 'a', args }, { result: 'a', text: summary }))?.command).toBe('bash')
    }
  })
})

describe('configured summary patterns', () => {
  it('derives totals and passed counts from what a pattern reports', () => {
    const patterns = compileTestSummary([{ name: 'failures only', summary: '^FAILURES: \\d+$', failed: 'FAILURES: (\\d+)' }])
    expect(ownTestOutcome(log({ call: 'a' }, { result: 'a', text: 'FAILURES: 2' }), 0, TOOLS, patterns))
      .toEqual({ passed: 0, failed: 2, total: 2, ok: false, command: 'cmd-a' })
    const optional = compileTestSummary([{ name: 'optional', summary: '^done(?: \\d+)?$', passed: 'done (\\d+)|done' }])
    expect(ownTestOutcome(log({ call: 'a' }, { result: 'a', text: 'done' }), 0, TOOLS, optional))
      .toEqual({ passed: 0, failed: 0, total: 0, ok: false, command: 'cmd-a' })
  })

  it.each<[string, LoomTestSummaryPattern, string]>([
    ['invalid summary', { name: 'p', summary: '(', passed: '(\\d+)' }, 'loom: outcomes.testSummary "p" summary is not a valid regular expression'],
    ['empty match', { name: 'p', summary: 'x*', passed: '(\\d+)' }, 'loom: outcomes.testSummary "p" summary matches empty text'],
    ['invalid count', { name: 'p', summary: 'x', total: '[' }, 'loom: outcomes.testSummary "p" total is not a valid regular expression'],
    ['no group', { name: 'p', summary: 'x', failed: '\\d+' }, 'loom: outcomes.testSummary "p" failed has no capture group'],
    ['no count', { name: 'p', summary: 'x', skipped: '(\\d+)' }, 'loom: outcomes.testSummary "p" needs passed, failed, or total'],
  ])('rejects a pattern with %s', (_name, pattern, message) => {
    expect(() => compileTestSummary([pattern])).toThrow(message)
  })
})
