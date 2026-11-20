import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { withheldAuditRecord } from '../fallbacks.js';
import { leaksSecret } from '../key-admission.js';
import { redactDeep } from '../redaction.js';
import { currentCallContext, currentInstancePolicy, currentRedactor } from './scope.js';

/**
 * Audit records of the embedded gateway. They go only to the host's sink
 * (InstancePolicy.audit); TELGEA_AUDIT_LOG is never read. The caller is
 * written as a pseudonym, the call's target only as a hash and an error only
 * as a fixed code. A sink that throws refuses the call, since a tool runs
 * only after its start record was accepted.
 */

export interface GatewayAuditEvent {
  tool: string;
  action: 'start' | 'finish' | 'error' | 'policy_denied' | 'rejected';
  target?: unknown;
  status?: string;
  reason?: string;
  error?: unknown;
}

/** The audit's code for an error: the HTTP status of a Telgea error, `timeout`, or `error`. */
export function auditErrorCode(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  if (error instanceof Error && error.name === 'TelgeaHttpError' && typeof status === 'number' && Number.isInteger(status)) {
    return `http_${status}`;
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout';
  return 'error';
}

/** The key of the caller pseudonyms: random per process, never written anywhere. */
const CALLER_KEY = randomBytes(32);

/** The caller as `hmac:` and 16 hex characters: the same caller gives the same pseudonym within the process. */
export function callerPseudonym(caller: string | undefined): string | undefined {
  if (caller === undefined || caller === '') return undefined;
  return `hmac:${createHmac('sha256', CALLER_KEY).update(caller, 'utf8').digest('hex').slice(0, 16)}`;
}

export async function writeGatewayAuditEvent(event: GatewayAuditEvent): Promise<void> {
  const sink = currentInstancePolicy()?.audit;
  if (!sink) return;
  const context = currentCallContext();
  const record = {
    timestamp: new Date().toISOString(),
    requestId: context.requestId ?? randomUUID(),
    tool: event.tool,
    caller: callerPseudonym(context.caller),
    action: event.action,
    targetHash: event.target === undefined ? undefined : hashValue(JSON.stringify(event.target)),
    status: event.status,
    reason: event.reason,
    error: event.error === undefined ? undefined : auditErrorCode(event.error),
  };
  // Redacted twice (the second pass covers what the first inserted), then copied through JSON: plain data.
  const redactor = currentRedactor();
  const safe = JSON.parse(JSON.stringify(redactDeep(redactDeep(record, redactor), redactor))) as Record<string, unknown>;
  // The sink check (src/key-admission.ts), on the record in its final form.
  await sink(redactor !== undefined && leaksSecret(safe, redactor) ? withheldAuditRecord() : safe);
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
