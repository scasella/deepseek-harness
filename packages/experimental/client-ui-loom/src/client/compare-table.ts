/**
 * Pure derivation of the Compare table: which rows share an outcome, how the
 * rows ran, and what each row costs. The table never ranks rows; it states
 * what each branch did and which branches did the same.
 */
import type { LoomMark } from '@deepseek-ai/dsh-experimental-loom/types'
import type { LoomCompareRow, LoomCompareTests, LoomIsolation } from '@deepseek-ai/dsh-experimental-loom/types'

/** Longest label of a row inside a sentence, in code points. */
const LABEL_MAX = 48

/** Rows that report the same test outcome. */
export interface LoomOutcomeGroup {
  /** Labels of the rows, in table order; at least two. */
  readonly labels: readonly string[]
  /** Whether the rows' diffs differ in files or in line counts, so the same outcome came from different changes. */
  readonly diffsDiffer: boolean
}

/** One table row with the mark it shows. */
export interface LoomTableRow {
  readonly row: LoomCompareRow
  /** The mark this browser shows: the one being saved or just saved, else the Host's. */
  readonly mark: LoomMark | null
  /** Whether the row belongs to an outcome group. */
  readonly grouped: boolean
}

/** How the rows' branches kept their files. */
export type LoomIsolationReading = LoomIsolation | 'mixed'

/** The derived table. */
export interface LoomCompareTable {
  readonly rows: readonly LoomTableRow[]
  readonly groups: readonly LoomOutcomeGroup[]
  readonly isolation: LoomIsolationReading
  /** Whether any row has a list-price cost, so the cost column says so. */
  readonly priced: boolean
}

/**
 * Key the outcome of a test run.
 * @param tests - parsed counts of a row.
 * @returns equal text exactly for equal outcomes.
 */
function outcomeKey(tests: LoomCompareTests): string {
  return [tests.ok, tests.passed, tests.failed, tests.total].join(':')
}

/**
 * Key the change a branch made.
 * @param row - the compare row.
 * @returns equal text exactly for equal changes; empty text for a row without a diff.
 */
function changeKey(row: LoomCompareRow): string {
  const { diff } = row
  if (diff === undefined) return ''
  return [diff.insertions, diff.deletions, ...diff.files.map(file => `${file.path}+${String(file.insertions)}-${String(file.deletions)}`)].join(':')
}

/**
 * Name a row inside a sentence: its title, or its steering line when the
 * rows' titles do not tell them apart, cut to a short length.
 * @param row - the compare row.
 * @param titlesDiffer - whether every row has its own title.
 * @param untitled - the name of a row with neither a title nor a steering line.
 * @returns the label.
 */
function labelOf(row: LoomCompareRow, titlesDiffer: boolean, untitled: string): string {
  const text = (titlesDiffer || row.prompt.trim() === '' ? row.title : row.prompt).replace(/\s+/gu, ' ').trim()
  const points = Array.from(text)
  if (points.length === 0) return untitled
  return points.length <= LABEL_MAX ? text : `${points.slice(0, LABEL_MAX - 1).join('')}…`
}

/**
 * Derive the Compare table of a set of sibling rows.
 * @param rows - the rows `loom.compare` returned, in its order.
 * @param markOf - the mark a row shows, which prefers this browser's saved state to the Host's value.
 * @param untitled - the name of a row without a title or a steering line.
 * @returns the rows with their marks, the groups of rows with one test outcome, the isolation reading, and whether costs are priced.
 */
export function compareTable(
  rows: readonly LoomCompareRow[],
  markOf: (row: LoomCompareRow) => LoomMark | null,
  untitled: string,
): LoomCompareTable {
  const titlesDiffer = new Set(rows.map(row => row.title)).size === rows.length
  const byOutcome = new Map<string, LoomCompareRow[]>()
  for (const row of rows) {
    if (row.tests === undefined) continue
    const key = outcomeKey(row.tests)
    const known = byOutcome.get(key)
    if (known === undefined) byOutcome.set(key, [row])
    else known.push(row)
  }
  const same = [...byOutcome.values()].filter(members => members.length > 1)
  const grouped = new Set(same.flat().map(row => row.sessionId))
  const isolations = new Set(rows.map(row => row.isolation))
  return {
    rows: rows.map(row => ({ row, mark: markOf(row), grouped: grouped.has(row.sessionId) })),
    groups: same.map(members => ({
      labels: members.map(row => labelOf(row, titlesDiffer, untitled)),
      diffsDiffer: new Set(members.map(changeKey)).size > 1,
    })),
    isolation: isolations.size > 1 ? 'mixed' : (rows[0]?.isolation ?? 'shared'),
    priced: rows.some(row => row.own.usd !== undefined),
  }
}
