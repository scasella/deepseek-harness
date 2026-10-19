/** Pair raw OpenAI-compatible token probabilities with pi-ai text deltas without retaining misaligned captures. */
import type { BlockTokenLogprobs } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'

const alternativeSchema = z.object({ token: z.string(), logprob: z.number().max(0) })
const tokensSchema = z.array(alternativeSchema.extend({ top_logprobs: z.array(alternativeSchema).optional() }))
const probabilitySchema = z.object({ content: tokensSchema.nullable().optional() })
const rawSchema = z.object({ choices: z.array(z.object({
  delta: z.object({ content: z.string().nullable().optional() }).optional(),
  logprobs: z.unknown().optional(),
})) })

/** One text block's aligned capture, or a missing/malformed provider sample. */
interface CaptureBlock {
  readonly parts: BlockTokenLogprobs[]
  missing: boolean
}

/** Per-request FIFO: the raw provider hook runs before the corresponding pi-ai text delta. */
export class TokenLogprobCapture {
  private readonly pending: (BlockTokenLogprobs | undefined)[] = []
  private readonly blocks = new Map<number, CaptureBlock>()

  /** @param degrade - receives a reason when one completed text block has no trustworthy capture. */
  constructor(private readonly degrade: (reason: string) => void) {}

  /**
   * Queue one sample only for a raw chunk that pi-ai will emit as a nonempty text delta.
   * @param raw - untrusted provider SSE chunk.
   */
  observe(raw: unknown): void {
    const parsed = rawSchema.safeParse(raw)
    if (!parsed.success) return
    const choice = parsed.data.choices[0]
    if (choice?.delta?.content === undefined || choice.delta.content === null || choice.delta.content.length === 0) return
    const probabilities = probabilitySchema.safeParse(choice.logprobs)
    const tokens = probabilities.success ? probabilities.data.content : undefined
    this.pending.push(tokens === undefined || tokens === null ? undefined : {
      tokens: tokens.map(value => value.token),
      logprobs: tokens.map(value => value.logprob === -9999 ? null : value.logprob),
      top: tokens.map(value => (value.top_logprobs ?? []).filter(alternative => alternative.logprob !== -9999)),
    })
  }

  /**
   * Bind the next raw sample to the text block pi-ai selected.
   * @param index - pi-ai content index.
   */
  delta(index: number): void {
    let block = this.blocks.get(index)
    if (block === undefined) {
      block = { parts: [], missing: false }
      this.blocks.set(index, block)
    }
    const next = this.pending.shift()
    if (next === undefined) block.missing = true
    else block.parts.push(next)
  }

  /**
   * Complete one block, dropping probabilities when any sample is missing or token text does not reproduce the block.
   * @param index - pi-ai content index.
   * @param text - complete block text.
   * @returns aligned capture, or undefined after reporting a missing or misaligned capture.
   */
  finish(index: number, text: string): BlockTokenLogprobs | undefined {
    const block = this.blocks.get(index)
    this.blocks.delete(index)
    if (block === undefined || block.missing) {
      this.degrade('missing token probabilities')
      return undefined
    }
    const tokens = block.parts.flatMap(part => part.tokens)
    if (tokens.join('') !== text) {
      this.degrade('token text does not match the completed block')
      return undefined
    }
    return { tokens, logprobs: block.parts.flatMap(part => part.logprobs), top: block.parts.flatMap(part => part.top) }
  }
}
