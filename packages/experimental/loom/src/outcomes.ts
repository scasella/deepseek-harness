/**
 * Test outcomes read from a Session's own command output: the model-facing
 * text of its own command-tool results, matched against configured summary
 * patterns. Tool-private result metadata is never read.
 */
import type { TextBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { LoomCommandTool, LoomCompareTests, LoomTestSummaryPattern } from './types.ts'

/** Summary patterns for Python unittest, pytest, Vitest, and Jest. */
export const DEFAULT_TEST_SUMMARY: readonly LoomTestSummaryPattern[] = [
  {
    name: 'unittest',
    summary: String.raw`^Ran \d+ tests? in \S+\s*\n+\s*(?:OK|FAILED)\b.*$`,
    total: String.raw`Ran (\d+) tests?`,
    failed: String.raw`failures=(\d+)`,
    errors: String.raw`errors=(\d+)`,
    skipped: String.raw`skipped=(\d+)`,
  },
  {
    name: 'pytest',
    summary: String.raw`^(?:=+ )?\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?)(?:, \d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?))* in [\d.]+s(?: \([^)\n]*\))?(?: =+)?$`,
    passed: String.raw`(\d+) passed`,
    failed: String.raw`(\d+) failed`,
    errors: String.raw`(\d+) errors?`,
    skipped: String.raw`(\d+) skipped`,
  },
  {
    name: 'vitest',
    summary: String.raw`^\s*Tests\s+\d+ (?:passed|failed|skipped|todo)(?: \| \d+ (?:passed|failed|skipped|todo))*\s+\(\d+\)`,
    passed: String.raw`(\d+) passed`,
    failed: String.raw`(\d+) failed`,
    skipped: String.raw`(\d+) skipped`,
    total: String.raw`\((\d+)\)`,
  },
  {
    name: 'jest',
    summary: String.raw`^Tests:\s+.*\b\d+ total$`,
    passed: String.raw`(\d+) passed`,
    failed: String.raw`(\d+) failed`,
    skipped: String.raw`(\d+) skipped`,
    total: String.raw`(\d+) total`,
  },
]

/** Count fields of a {@link LoomTestSummaryPattern}. */
const COUNT_KEYS = ['passed', 'failed', 'errors', 'skipped', 'total'] as const
type CountKey = typeof COUNT_KEYS[number]

/** One validated summary pattern. */
export interface CompiledTestSummary {
  readonly name: string
  /** Global, multiline summary expression. */
  readonly summary: RegExp
  readonly counts: Partial<Record<CountKey, RegExp>>
}

/** Terminal control sequences that colored test runners interleave with their summaries. */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')

/**
 * Compile configured summary patterns, rejecting any that cannot work.
 * @param patterns - configured `outcomes.testSummary`.
 * @returns the compiled patterns in order.
 * @throws Error naming the pattern for invalid regular expression source, a
 *   summary that matches empty text, a count without a capture group, or a
 *   pattern with none of `passed`, `failed`, and `total`.
 */
export function compileTestSummary(patterns: readonly LoomTestSummaryPattern[]): CompiledTestSummary[] {
  return patterns.map((pattern) => {
    const compile = (field: string, source: string, flags: string): RegExp => {
      try {
        return new RegExp(source, flags)
      } catch (error) {
        throw new Error(`loom: outcomes.testSummary "${pattern.name}" ${field} is not a valid regular expression`, { cause: error })
      }
    }
    const summary = compile('summary', pattern.summary, 'gm')
    if (compile('summary', pattern.summary, 'm').test('')) throw new Error(`loom: outcomes.testSummary "${pattern.name}" summary matches empty text`)
    const counts: Partial<Record<CountKey, RegExp>> = {}
    for (const key of COUNT_KEYS) {
      const source = pattern[key]
      if (source === undefined) continue
      counts[key] = compile(key, source, '')
      // An alternation with the empty pattern matches empty text and reports every group of `source`.
      const probe = compile(key, `${source}|`, '').exec('')
      /* v8 ignore next -- the probe above never fails to match. */
      const groups = probe === null ? 0 : probe.length - 1
      if (groups < 1) throw new Error(`loom: outcomes.testSummary "${pattern.name}" ${key} has no capture group`)
    }
    if (counts.passed === undefined && counts.failed === undefined && counts.total === undefined) {
      throw new Error(`loom: outcomes.testSummary "${pattern.name}" needs passed, failed, or total`)
    }
    return { name: pattern.name, summary, counts }
  })
}

/**
 * The command a call ran: its configured string argument, or the tool name
 * when the arguments hold none.
 * @param argumentsText - raw JSON arguments of the call.
 * @param tool - the call's command tool.
 * @returns the command text.
 */
function commandOf(argumentsText: string, tool: LoomCommandTool): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsText)
  } catch {
    // Malformed arguments name no command; the tool name stands for it.
    return tool.name
  }
  if (typeof parsed !== 'object' || parsed === null) return tool.name
  const command: unknown = Reflect.get(parsed, tool.commandArgument)
  return typeof command === 'string' ? command : tool.name
}

/**
 * The last summary match in one output, by end position across patterns.
 * @param text - output with control sequences removed.
 * @param patterns - compiled patterns.
 * @returns the matched text and its pattern, or undefined.
 */
function lastSummary(text: string, patterns: readonly CompiledTestSummary[]): { text: string; pattern: CompiledTestSummary } | undefined {
  let found: { text: string; pattern: CompiledTestSummary; end: number } | undefined
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.summary)) {
      const end = match.index + match[0].length
      if (found === undefined || end >= found.end) found = { text: match[0], pattern, end }
    }
  }
  return found
}

/**
 * Counts of one matched summary.
 * @param text - the matched summary text.
 * @param pattern - the pattern that matched it.
 * @param command - the command that printed it.
 * @returns the outcome; failed includes errors, and the total includes skipped tests.
 */
function outcomeOf(text: string, pattern: CompiledTestSummary, command: string): LoomCompareTests {
  const count = (key: CountKey): number | undefined => {
    const value = pattern.counts[key]?.exec(text)?.[1]
    return value === undefined ? undefined : Number(value)
  }
  const failed = (count('failed') ?? 0) + (count('errors') ?? 0)
  const skipped = count('skipped') ?? 0
  const passed = count('passed')
  const total = count('total') ?? (passed ?? 0) + failed + skipped
  return { passed: passed ?? Math.max(0, total - failed - skipped), failed, total, ok: failed === 0 && total > 0, command }
}

/**
 * The last test summary in a Session's own command output: own results of
 * own calls to a configured command tool, read from their model-facing text
 * content, latest result first.
 * @param events - complete Session log.
 * @param inheritedEventCount - events the Session inherited at its fork.
 * @param tools - configured command tools.
 * @param patterns - compiled summary patterns.
 * @returns the outcome, or undefined when no own command output holds a summary.
 */
export function ownTestOutcome(
  events: readonly SessionEvent[],
  inheritedEventCount: number,
  tools: readonly LoomCommandTool[],
  patterns: readonly CompiledTestSummary[],
): LoomCompareTests | undefined {
  const calls = new Map<string, { readonly tool: LoomCommandTool; readonly arguments: string }>()
  let outcome: LoomCompareTests | undefined
  for (const event of events.slice(inheritedEventCount)) {
    if (event.type === 'tool/call') {
      const tool = tools.find(candidate => candidate.name === event.data.name)
      if (tool !== undefined) calls.set(event.data.callId, { tool, arguments: event.data.arguments })
      continue
    }
    if (event.type !== 'tool/result') continue
    const call = calls.get(event.data.message.toolCallId)
    if (call === undefined) continue
    const text = event.data.message.content
      .filter((block): block is TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .replace(ANSI_ESCAPE, '')
    const summary = lastSummary(text, patterns)
    if (summary !== undefined) outcome = outcomeOf(summary.text, summary.pattern, commandOf(call.arguments, call.tool))
  }
  return outcome
}
