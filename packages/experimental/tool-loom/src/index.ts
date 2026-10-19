/**
 * Experimental autoloom tools: a weaver model branches Sessions through the
 * Loom service, waits for and reads the branches, and keeps or archives
 * them, under per-weaver branch, depth, and own-token budgets.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-experimental-loom'
import type {} from '@deepseek-ai/dsh-token-meter'
import { AUTO_PRESET } from '@deepseek-ai/dsh-permission-presets'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { AutoloomRuntime, type AutoloomLimits } from './runtime.ts'
import { registerAutoloomTools } from './tools.ts'

export { AutoloomRefusal, BUDGET_STOP_REASON, CULL_STOP_REASON, type AutoloomRefusalCode } from './runtime.ts'
export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'tool-loom'

/** Services the autoloom tools act through. */
export const inject = [
  'agents',
  'loom',
  'permissionPresets',
  'sessionController',
  'sessionProjections',
  'sessionQuery',
  'tokenMeter',
  'tools',
  'workspaceRegistry',
]

/** Budgets of one weaver Session; omitted fields take their defaults. */
export interface AutoloomConfig {
  /** Most children one weaver Session may start; a larger expansion is refused before any fork. Default 8. */
  readonly maxBranches?: number
  /**
   * Deepest generation of children: a child of a Session the weaver did not
   * start is generation 1, and its own child generation 2. A deeper
   * expansion is refused before any fork. Default 2.
   */
  readonly maxDepth?: number
  /**
   * Most tokens the weaver's children may use in their own requests, summed
   * over every child: uncached input, cache reads, cache writes, and output.
   * Expansions are refused once the sum reaches it, and when the sum passes
   * it every running child is stopped and every queued child is withdrawn.
   * Default 2,000,000.
   */
  readonly maxOwnTokens?: number
  /** Maximum list-price dollars of the children's own requests; omitted disables the dollar budget. Unpriced routes are refused. */
  readonly maxUsd?: number
  /**
   * Permission preset every child runs with, applied before its prompt. Its
   * approval policy must be `never`; a configured preset that asks for
   * approvals fails the plugin load. `auto` is checked at each expansion,
   * because the Auto preset exists only while its review plugin is loaded.
   * Default `auto`.
   */
  readonly childPermissionPreset?: string
}

/** Autoloom budgets and the bounds of the wait and read tools; omitted fields take their defaults. */
export interface Config {
  /** Budgets of every weaver Session. */
  readonly autoloom?: AutoloomConfig
  /** Wait of a `loom_wait` call that names no timeout, in milliseconds; at most `maxWaitMs`. Default 120,000. */
  readonly defaultWaitMs?: number
  /** Longest wait a `loom_wait` call may name, in milliseconds. Default 1,800,000. */
  readonly maxWaitMs?: number
  /** Output length of a `loom_read` call that names none, in characters; at most `maxReadChars`. Default 4,000. */
  readonly defaultReadChars?: number
  /** Longest output a `loom_read` call may ask for, in characters. Default 20,000. */
  readonly maxReadChars?: number
}

/** Loader schema; the plugin receives {@link AutoloomLimits}. */
export const Config: z<Config, AutoloomLimits> = z.object({
  autoloom: z.object({
    maxBranches: z.natural().min(1).default(8),
    maxDepth: z.natural().min(1).default(2),
    maxOwnTokens: z.natural().min(1).default(2_000_000),
    maxUsd: z.number().min(Number.MIN_VALUE),
    childPermissionPreset: z.string().min(1).default(AUTO_PRESET),
  }),
  defaultWaitMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  maxWaitMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(1_800_000),
  defaultReadChars: z.natural().min(1).default(4_000),
  maxReadChars: z.natural().min(1).default(20_000),
})

/**
 * Check the limits the schema cannot relate and a configured preset that is
 * known at load.
 * @param ctx - plugin Context carrying the permission presets.
 * @param limits - limits after schema defaults.
 * @throws Error when a default exceeds its maximum, or when a configured child preset other than `auto` is unknown
 *   or asks for approvals.
 */
function assertLimits(ctx: Context, limits: AutoloomLimits): void {
  if (limits.autoloom.maxUsd !== undefined && (!Number.isFinite(limits.autoloom.maxUsd) || limits.autoloom.maxUsd <= 0)) throw new Error('tool-loom: autoloom.maxUsd must be finite and greater than zero')
  if (limits.defaultWaitMs > limits.maxWaitMs) throw new Error('tool-loom: defaultWaitMs must not exceed maxWaitMs')
  if (limits.defaultReadChars > limits.maxReadChars) throw new Error('tool-loom: defaultReadChars must not exceed maxReadChars')
  const preset = limits.autoloom.childPermissionPreset
  if (preset === AUTO_PRESET) return
  const { approval } = ctx.permissionPresets.resolve(preset)
  if (approval !== 'never') {
    throw new Error(`tool-loom: autoloom.childPermissionPreset "${preset}" asks for approvals; branches need a preset whose approval is never`)
  }
}

/**
 * Register the autoloom tools and the own-token watcher for the plugin's lifetime.
 * @param ctx - plugin Context.
 * @param limits - budgets and bounds after schema defaults.
 * @throws Error for limits {@link assertLimits} rejects.
 */
export function apply(ctx: Context, limits: AutoloomLimits): void {
  assertLimits(ctx, limits)
  registerAutoloomTools(ctx, new AutoloomRuntime(ctx, limits), limits)
}
