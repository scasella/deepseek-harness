/** Telemetry redaction for Loom plugin records. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'

/** Event-type prefix of every record this package declares. */
const LOOM_RECORD_PREFIX = 'plugin:loom/'

/**
 * Remove the payload of every exported `plugin:loom/*` ledger record. The
 * record keeps its `sourceEvent` envelope, so the exported ledger still shows
 * the record type and seq; `body` becomes `null`. Other records pass through
 * the rules beneath this listener unchanged.
 * @param record - result of the rules beneath this listener.
 * @returns the record with a Loom payload removed.
 */
export function redactLoomRecord(record: SessionTelemetryRecord): SessionTelemetryRecord {
  const type: string | undefined = record.sourceEvent?.envelope.type
  return type?.startsWith(LOOM_RECORD_PREFIX) === true ? { ...record, body: null } : record
}

/**
 * Mount the redaction rule on the `session-telemetry/record` waterfall for the
 * lifetime of `ctx`.
 * @param ctx - owning plugin Context.
 */
export function installLoomTelemetryRedaction(ctx: Context): void {
  ctx.on('session-telemetry/record', (_record, next) => redactLoomRecord(next()))
}
