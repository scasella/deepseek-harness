/** Token capture restricted to a retained model prefix; a partial last token stays unmarked. */
import type { BlockTokenLogprobs } from '@deepseek-ai/dsh-llm/types'

/**
 * Keep exact captured tokens before a prose cursor without assigning a probability to a partial token.
 * @param text - retained initial substring of a captured model block.
 * @param captured - provider capture for that complete block.
 * @returns aligned prefix capture, or undefined when the text is not its initial substring.
 */
export function capturedPrefix(text: string, captured: BlockTokenLogprobs): BlockTokenLogprobs | undefined {
  const full = captured.tokens.join('')
  if (full === text) return captured
  if (!full.startsWith(text)) return undefined
  let end = 0
  let count = 0
  for (const token of captured.tokens) {
    if (end + token.length > text.length) break
    end += token.length; count++
  }
  const partial = text.slice(end)
  return {
    tokens: [...captured.tokens.slice(0, count), ...partial === '' ? [] : [partial]],
    logprobs: [...captured.logprobs.slice(0, count), ...partial === '' ? [] : [null]],
    top: [...captured.top.slice(0, count), ...partial === '' ? [] : [[]]],
  }
}
