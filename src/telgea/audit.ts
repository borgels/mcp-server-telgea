import { createHash, randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { formatUnknownError } from '../errors.js';

export interface TelgeaAuditEvent {
  requestId?: string;
  actingAs?: string;
  tool: string;
  action: 'start' | 'finish' | 'error' | 'policy_denied';
  target?: unknown;
  status?: string;
  reason?: string;
  error?: unknown;
  /** Prepared-operation hash, so a commit can be tied to its prepare. */
  operationHash?: string;
}

/**
 * Telgea attributes every change to the API key, not a person, so this log
 * is what ties a change to the user who actually made it. Arguments are
 * hashed, never stored: they carry names, emails and phone numbers.
 */
export async function writeAuditEvent(event: TelgeaAuditEvent): Promise<void> {
  const auditPath = process.env.TELGEA_AUDIT_LOG;
  if (!auditPath) {
    return;
  }

  const record = {
    timestamp: new Date().toISOString(),
    requestId: event.requestId ?? randomUUID(),
    actingAs: event.actingAs,
    tool: event.tool,
    action: event.action,
    targetHash: event.target === undefined ? undefined : hashValue(JSON.stringify(event.target)),
    operationHash: event.operationHash,
    status: event.status,
    reason: event.reason,
    error: event.error === undefined ? undefined : formatUnknownError(event.error),
  };

  await appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
