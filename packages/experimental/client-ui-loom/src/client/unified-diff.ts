/**
 * Reader of git unified diff text for the `DiffBlock` primitive, which takes
 * the old and new text of each hunk and derives its own patch rows.
 */
import type { DiffHunk } from '@deepseek-ai/dsh-client-ui-primitives'

/** A unified diff reduced to what the Loom compare detail draws. */
export interface ParsedUnifiedDiff {
  /** One entry per hunk in the diff's order; consecutive hunks of one file share its path. */
  readonly hunks: DiffHunk[]
  /** Paths the diff reports as binary, which have no text to draw. */
  readonly binary: string[]
}

/** `diff --git a/<old> b/<new>`: the second path names the file after the change. */
const FILE_HEADER = /^diff --git a\/.+? b\/(.+)$/u
/** `@@ -<start>[,<old count>] +<start>[,<new count>] @@`; an omitted count is 1. */
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/u
/** `Binary files a/<path> and b/<path> differ`. */
const BINARY_FILES = /^Binary files .+ differ$/u
/** `+++ b/<path>`, with the tab git appends to a path that holds spaces. */
const NEW_PATH = /^\+\+\+ b\/([^\t]+)/u

/**
 * Join lines into the newline-terminated text `DiffBlock` splits again.
 * @param lines - the lines of one side of a hunk.
 * @returns the text, empty for no lines.
 */
function textOf(lines: readonly string[]): string {
  return lines.map(line => `${line}\n`).join('')
}

/**
 * Read a git unified diff into one `DiffBlock` hunk per `@@` section. A section
 * ends when its header's line counts are consumed, so a removed line that
 * begins with `--` is never taken for a file header; a section the Host cut
 * short ends with the text.
 * @param unified - unified diff text as `loom.diff` returns it.
 * @returns the hunks and the binary files; empty for text without either.
 */
export function parseUnifiedDiff(unified: string): ParsedUnifiedDiff {
  const lines = (unified.endsWith('\n') ? unified.slice(0, -1) : unified).split('\n')
  const hunks: DiffHunk[] = []
  const binary: string[] = []
  let path = ''
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] as string
    const file = FILE_HEADER.exec(line)
    if (file !== null) {
      path = file[1] as string
      continue
    }
    const renamed = NEW_PATH.exec(line)
    if (renamed !== null) {
      path = renamed[1] as string
      continue
    }
    if (BINARY_FILES.test(line)) {
      binary.push(path)
      continue
    }
    const header = HUNK_HEADER.exec(line)
    if (header === null) continue
    let oldLeft = header[1] === undefined ? 1 : Number(header[1])
    let newLeft = header[2] === undefined ? 1 : Number(header[2])
    const oldLines: string[] = []
    const newLines: string[] = []
    while ((oldLeft > 0 || newLeft > 0) && at + 1 < lines.length) {
      const body = lines[at + 1] as string
      const marker = body[0]
      if (marker === '-') {
        oldLines.push(body.slice(1))
        oldLeft -= 1
      } else if (marker === '+') {
        newLines.push(body.slice(1))
        newLeft -= 1
      } else if (marker === ' ' || marker === undefined) {
        // An editor can strip the single space of a blank context line.
        oldLines.push(body.slice(1))
        newLines.push(body.slice(1))
        oldLeft -= 1
        newLeft -= 1
      } else if (marker !== '\\') break
      at += 1
    }
    hunks.push({ path, oldText: textOf(oldLines), newText: textOf(newLines) })
  }
  return { hunks, binary }
}
