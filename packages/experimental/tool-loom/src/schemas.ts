/** Parameter and canonical result schemas of the five autoloom tools. */
import type { InferValue } from '@deepseek-ai/dsh-tools'

const SESSION_ID = { type: 'string', required: true } as const

/** What remains of the calling weaver's budget. */
const BUDGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    branchesLeft: { type: 'integer', required: true },
    usdLeft: { type: 'number' },
    ownTokensLeft: { type: 'integer', required: true },
    maxDepth: { type: 'integer', required: true },
  },
} as const

/** `loom_expand` arguments. */
export const EXPAND_PARAMETERS = {
  sessionId: {
    type: 'string',
    description: 'Session to branch: another Session in the same working directory. Omit to branch this Session.',
  },
  afterTurn: {
    type: 'integer',
    required: true,
    description: 'Last turn every child keeps; each child continues from the end of this turn.',
  },
  lines: {
    type: 'array',
    items: { type: 'string' },
    description: 'One prompt per child, sent verbatim as that child\'s next user message. Give exactly one of lines and count.',
  },
  count: {
    type: 'integer',
    description: 'Number of children that each resend the opening prompt of turn afterTurn + 1 to sample that turn again. Give exactly one of lines and count.',
  },
} as const

/** `loom_expand` result: the new branch set and its children. */
export const EXPAND_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    setId: { type: 'string', required: true },
    children: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', required: true },
          state: { type: 'string', required: true, enum: ['started', 'queued', 'failed', 'cancelled'] },
          sessionId: { type: 'string' },
          error: { type: 'string' },
        },
      },
    },
    budget: BUDGET_SCHEMA,
  },
} as const

/** `loom_wait` parameter schema; the timeout description states the configured bounds. */
export type WaitParameters = {
  readonly setId: { readonly type: 'string'; readonly required: true; readonly description: string }
  readonly timeoutMs: { readonly type: 'integer'; readonly description: string }
}

/**
 * `loom_wait` arguments.
 * @param defaultWaitMs - wait of a call without a timeout.
 * @param maxWaitMs - longest accepted timeout.
 * @returns the parameter schema.
 */
export function waitParameters(defaultWaitMs: number, maxWaitMs: number): WaitParameters {
  return {
    setId: { type: 'string', required: true, description: 'Branch set id returned by loom_expand.' },
    timeoutMs: {
      type: 'integer',
      description: `Longest wait in milliseconds, from 1 through ${String(maxWaitMs)}. Defaults to ${String(defaultWaitMs)}.`,
    },
  }
}

/** `loom_wait` result: every child of the set when the wait ended. */
export const WAIT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    setId: { type: 'string', required: true },
    timedOut: { type: 'boolean', required: true },
    children: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', required: true },
          state: { type: 'string', required: true, enum: ['queued', 'running', 'idle', 'failed', 'cancelled'] },
          sessionId: { type: 'string' },
          ownTokens: { type: 'integer' },
          stoppedByBudget: { type: 'boolean', const: true },
          error: { type: 'string' },
        },
      },
    },
    budget: BUDGET_SCHEMA,
  },
} as const

/** `loom_read` parameter schema; the length description states the configured bounds. */
export type ReadParameters = {
  readonly sessionId: { readonly type: 'string'; readonly required: true; readonly description: string }
  readonly maxChars: { readonly type: 'integer'; readonly description: string }
}

/**
 * `loom_read` arguments.
 * @param defaultReadChars - output length of a call without a limit.
 * @param maxReadChars - longest accepted limit.
 * @returns the parameter schema.
 */
export function readParameters(defaultReadChars: number, maxReadChars: number): ReadParameters {
  return {
    sessionId: { ...SESSION_ID, description: 'Child Session returned by loom_expand or loom_wait.' },
    maxChars: {
      type: 'integer',
      description: `Longest output to return, in characters, from 1 through ${String(maxReadChars)}. Defaults to ${String(defaultReadChars)}.`,
    },
  }
}

/** `loom_read` result: the child's latest output and state. */
export const READ_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true },
    state: { type: 'string', required: true, enum: ['running', 'idle'] },
    output: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
    chars: { type: 'integer', required: true },
    ownTokens: { type: 'integer', required: true },
    stoppedByBudget: { type: 'boolean', const: true },
    archived: { type: 'boolean', const: true },
  },
} as const

/** `loom_cull` and `loom_keep` arguments. */
export const CHILD_PARAMETERS = {
  sessionId: { ...SESSION_ID, description: 'Child Session returned by loom_expand or loom_wait.' },
} as const

/** `loom_cull` result. */
export const CULL_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true },
    stopped: { type: 'boolean', required: true },
    archived: { type: 'boolean', required: true, const: true },
  },
} as const

/** `loom_keep` result. */
export const KEEP_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string', required: true },
    mark: { type: 'string', required: true, const: 'keep' },
  },
} as const

/** Budget left, as every result reports it. */
export type BudgetValue = InferValue<typeof BUDGET_SCHEMA>
/** Canonical `loom_expand` result. */
export type ExpandValue = InferValue<typeof EXPAND_VALUE_SCHEMA>
/** One child of a `loom_expand` result. */
export type ExpandChildValue = ExpandValue['children'][number]
/** Canonical `loom_wait` result. */
export type WaitValue = InferValue<typeof WAIT_VALUE_SCHEMA>
/** One child of a `loom_wait` result. */
export type WaitChildValue = WaitValue['children'][number]
/** Canonical `loom_read` result. */
export type ReadValue = InferValue<typeof READ_VALUE_SCHEMA>
/** Canonical `loom_cull` result. */
export type CullValue = InferValue<typeof CULL_VALUE_SCHEMA>
/** Canonical `loom_keep` result. */
export type KeepValue = InferValue<typeof KEEP_VALUE_SCHEMA>
