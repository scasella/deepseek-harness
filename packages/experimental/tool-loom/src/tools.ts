/** Registrations of the five autoloom tools over the autoloom runtime. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type InferValue, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import * as presentation from './presentation.ts'
import type { AutoloomLimits, AutoloomRuntime } from './runtime.ts'
import {
  CHILD_PARAMETERS,
  CULL_VALUE_SCHEMA,
  EXPAND_PARAMETERS,
  EXPAND_VALUE_SCHEMA,
  KEEP_VALUE_SCHEMA,
  READ_VALUE_SCHEMA,
  WAIT_VALUE_SCHEMA,
  readParameters,
  waitParameters,
} from './schemas.ts'

/**
 * Declare one canonical output schema rendered as compact JSON.
 * @param schema - canonical value schema for one tool.
 * @returns the `output` declaration accepted by {@link defineTool}.
 */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S) {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  }
}

/**
 * Recover the calling Agent, which the agent loop sets on every model call.
 * @param agent - the execution's Agent.
 * @param toolName - the tool, for the failure message.
 * @returns the Agent.
 * @throws Error for a call without an Agent, such as a direct registry dispatch.
 */
function callingAgent(agent: Agent | undefined, toolName: string): Agent {
  if (agent === undefined) throw new Error(`${toolName} requires a calling Session`)
  return agent
}

/**
 * Register `loom_expand`, `loom_wait`, `loom_read`, `loom_cull`, and
 * `loom_keep` for every Agent, each as an effect of `ctx`.
 * @param ctx - tool plugin Context carrying the tool registry.
 * @param runtime - the runs and budgets the tools act on.
 * @param limits - bounds the wait and read schemas state.
 */
export function registerAutoloomTools(ctx: Context, runtime: AutoloomRuntime, limits: AutoloomLimits): void {
  ctx.tools.register(defineTool({
    name: 'loom_expand',
    description: 'Branch a Session into child Sessions that continue from the end of one turn: one child per prompt line, or count children that sample the next turn again. Children run in the background with a non-interactive permission preset; follow them with loom_wait and loom_read. A call that would exceed this Session\'s branch, depth, or own-token budget is refused without creating any child.',
    parameters: EXPAND_PARAMETERS,
    output: jsonOutput(EXPAND_VALUE_SCHEMA),
    execute: (args, exec) => runtime.expand(callingAgent(exec.agent, 'loom_expand'), args, exec.callId, exec.signal),
    presentCall: presentation.presentExpandCall,
    presentResult: presentation.presentExpandResult,
  }))

  ctx.tools.register(defineTool({
    name: 'loom_wait',
    description: 'Wait until every child of a branch set has finished its turn, failed, or been withdrawn, or until the timeout passes. Returns each child\'s state and the tokens of its own requests.',
    parameters: waitParameters(limits.defaultWaitMs, limits.maxWaitMs),
    output: jsonOutput(WAIT_VALUE_SCHEMA),
    execute: (args, exec) => runtime.wait(callingAgent(exec.agent, 'loom_wait'), args.setId, args.timeoutMs, exec.signal),
    presentCall: presentation.presentWaitCall,
  }))

  ctx.tools.register(defineTool({
    name: 'loom_read',
    description: 'Read the latest assistant output of a child this Session started, with its state and the tokens of its own requests.',
    parameters: readParameters(limits.defaultReadChars, limits.maxReadChars),
    output: jsonOutput(READ_VALUE_SCHEMA),
    execute: (args, exec) => runtime.read(callingAgent(exec.agent, 'loom_read'), args.sessionId, args.maxChars, exec.signal),
    presentCall: presentation.presentReadCall,
  }))

  ctx.tools.register(defineTool({
    name: 'loom_cull',
    description: 'Stop a child this Session started and archive it. The archive keeps its history.',
    parameters: CHILD_PARAMETERS,
    output: jsonOutput(CULL_VALUE_SCHEMA),
    execute: (args, exec) => runtime.cull(callingAgent(exec.agent, 'loom_cull'), args.sessionId, exec.signal),
    presentCall: presentation.presentCullCall,
    presentResult: presentation.presentCullResult,
  }))

  ctx.tools.register(defineTool({
    name: 'loom_keep',
    description: 'Mark a child this Session started as kept.',
    parameters: CHILD_PARAMETERS,
    output: jsonOutput(KEEP_VALUE_SCHEMA),
    execute: (args, exec) => runtime.keep(callingAgent(exec.agent, 'loom_keep'), args.sessionId, exec.signal),
    presentCall: presentation.presentKeepCall,
    presentResult: presentation.presentKeepResult,
  }))
}
