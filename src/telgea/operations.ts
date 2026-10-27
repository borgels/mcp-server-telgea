import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TelgeaHttpError } from '../errors.js';
import { pathSegment, type HttpMethod, type TelgeaClient } from './client.js';
import { assertWritesEnabled } from './policy.js';
import { redactSimSecrets } from './redact.js';

/**
 * Two-step changes for what costs money or cannot be undone from here:
 * new plans and lines (billable), SIM swaps (the old SIM stops working),
 * port-ins (moves a number from another operator), terminations and
 * deleting users.
 *
 * prepare: reads the target (so the preview names who and what is
 *   affected), builds the exact HTTP step and signs it with an HMAC.
 * commit:  accepts only an operation this server signed, unexpired,
 *   prepared by the same user, echoed back with its hash, and whose step
 *   still passes the allowlist — then sends it with an Idempotency-Key
 *   derived from the hash, so committing the same operation twice replays
 *   Telgea's first answer instead of ordering a second line.
 *
 * The gateway can gate telgea_commit_prepared_operation with a duty group,
 * so preparing and committing can be separate privileges.
 */

export const CHANGE_KINDS = [
  'create_user_plan',
  'add_line',
  'replace_sim',
  'terminate_line',
  'terminate_plan',
  'delete_user',
  'submit_port_in',
  'discard_port_in',
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export type TelgeaChange =
  | { kind: 'create_user_plan'; userId: string; countryCode: string }
  | { kind: 'add_line'; userId: string; countryCode: string }
  | { kind: 'replace_sim'; numberId: string }
  | { kind: 'terminate_line'; numberId: string; terminationDate: string; deleteUser?: boolean }
  | { kind: 'terminate_plan'; userId: string; terminationDate: string; deleteUser?: boolean }
  | { kind: 'delete_user'; userId: string }
  | {
      kind: 'submit_port_in';
      userId: string;
      countryCode: string;
      msisdn: string;
      executionDate: string;
      type: string;
      fields: Record<string, unknown>;
    }
  | { kind: 'discard_port_in'; portInId: string };

export interface OperationStep {
  method: Exclude<HttpMethod, 'GET'>;
  path: string;
  body?: unknown;
}

export interface PreparedOperation {
  kind: ChangeKind;
  steps: OperationStep[];
  preview: unknown;
  warnings: string[];
  reason: string;
  actingAs: string;
  preparedAt: string;
  expiresAt: string;
  operationHash: string;
}

const TTL_MS = 15 * 60 * 1000;
const processSecret = randomBytes(32);

function secret(): Buffer {
  const configured = process.env.TELGEA_OPERATION_SECRET;
  return configured ? Buffer.from(configured, 'utf8') : processSecret;
}

export async function prepareChange(
  client: TelgeaClient,
  change: TelgeaChange,
  context: { reason: string; actingAs: string; now?: Date },
): Promise<PreparedOperation> {
  assertWritesEnabled(`prepare ${change.kind}`);
  const { steps, preview, warnings } = await planChange(client, change, context.now ?? new Date());
  for (const step of steps) {
    assertAllowedStep(step);
  }
  const preparedAt = context.now ?? new Date();
  const unsigned = {
    kind: change.kind,
    steps,
    preview,
    warnings,
    reason: context.reason,
    actingAs: context.actingAs,
    preparedAt: preparedAt.toISOString(),
    expiresAt: new Date(preparedAt.getTime() + TTL_MS).toISOString(),
  };
  return { ...unsigned, operationHash: sign(unsigned) };
}

export function verifyPreparedOperation(
  operation: PreparedOperation,
  context: { confirmOperationHash: string; actingAs: string; now?: Date },
): PreparedOperation {
  const { operationHash, ...unsigned } = operation;
  const expected = Buffer.from(sign(unsigned), 'hex');
  const given = Buffer.from(String(operationHash ?? ''), 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new Error('Prepared operation signature does not match; it was altered or prepared by another server. Prepare it again.');
  }
  if (context.confirmOperationHash !== operationHash) {
    throw new Error('confirmOperationHash does not match the operation; echo the operationHash from the prepare result.');
  }
  if ((context.now ?? new Date()).getTime() > Date.parse(operation.expiresAt)) {
    throw new Error('Prepared operation has expired (15 minutes); prepare it again.');
  }
  if (operation.actingAs !== context.actingAs) {
    throw new Error('Prepared operation belongs to another user; the committing user must prepare it themselves.');
  }
  if (!Array.isArray(operation.steps) || operation.steps.length === 0) {
    throw new Error('Prepared operation has no steps.');
  }
  for (const step of operation.steps) {
    assertAllowedStep(step);
  }
  return operation;
}

export async function commitPreparedOperation(client: TelgeaClient, operation: PreparedOperation) {
  assertWritesEnabled(`commit ${operation.kind}`);
  const results: Array<{ step: number; method: string; path: string; ok: boolean; response?: unknown; error?: string }> = [];
  for (const [index, step] of operation.steps.entries()) {
    try {
      const response = await client.send(step.method, step.path, {
        body: step.body,
        idempotencyKey: `mcp-${operation.operationHash.slice(0, 48)}-${index + 1}`,
      });
      results.push({ step: index + 1, method: step.method, path: step.path, ok: true, response: redactSimSecrets(response) });
    } catch (error) {
      results.push({
        step: index + 1,
        method: step.method,
        path: step.path,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  const failed = results.find(result => !result.ok);
  return {
    kind: operation.kind,
    completed: results.filter(result => result.ok).length,
    total: operation.steps.length,
    status: failed ? (results.length === 1 ? 'failed' : 'partially_applied') : 'applied',
    results,
  };
}

async function planChange(
  client: TelgeaClient,
  change: TelgeaChange,
  now: Date,
): Promise<{ steps: OperationStep[]; preview: unknown; warnings: string[] }> {
  const warnings: string[] = [];
  switch (change.kind) {
    case 'create_user_plan': {
      const userId = pathSegment(change.userId, 'userId');
      const existing = await userPlanOrNull(client, userId);
      if (existing) {
        warnings.push('This user already has a plan; Telgea will most likely refuse a second one.');
      }
      warnings.push('A new plan is billable and provisions a local and a travel number with eSIMs.');
      return {
        steps: [{ method: 'POST', path: '/v1/user-plans', body: { userId: change.userId, countryCode: upperCountry(change.countryCode) } }],
        preview: { userId: change.userId, countryCode: upperCountry(change.countryCode), existingPlan: summarizePlan(existing) },
        warnings,
      };
    }
    case 'add_line': {
      const userId = pathSegment(change.userId, 'userId');
      const plan = await userPlanOrNull(client, userId);
      if (!plan) {
        warnings.push('No user plan found for this user; Telgea may refuse the line.');
      }
      warnings.push('A new line is billable.');
      return {
        steps: [{ method: 'POST', path: '/v1/numbers', body: { userId: change.userId, countryCode: upperCountry(change.countryCode) } }],
        preview: { countryCode: upperCountry(change.countryCode), user: summarizePlan(plan) },
        warnings,
      };
    }
    case 'replace_sim': {
      const numberId = pathSegment(change.numberId, 'numberId');
      const line = await client.get<Record<string, unknown>>(`/v1/numbers/${numberId}`);
      warnings.push('The current SIM stops working once the replacement is activated; the new eSIM must be installed on the device.');
      return {
        steps: [{ method: 'POST', path: `/v1/numbers/${numberId}/sim-replacement` }],
        preview: { line: summarizeLine(line) },
        warnings,
      };
    }
    case 'terminate_line': {
      const numberId = pathSegment(change.numberId, 'numberId');
      assertTerminationDate(change.terminationDate, now);
      const line = await client.get<Record<string, unknown>>(`/v1/numbers/${numberId}`);
      warnings.push('The number is released when the line ends and cannot be recovered through this server.');
      if (change.deleteUser) warnings.push('deleteUser=true also deletes the user once the line has ended.');
      return {
        steps: [
          {
            method: 'POST',
            path: `/v1/numbers/${numberId}/termination`,
            body: { terminationDate: change.terminationDate, ...(change.deleteUser === undefined ? {} : { deleteUser: change.deleteUser }) },
          },
        ],
        preview: { line: summarizeLine(line), terminationDate: change.terminationDate, deleteUser: change.deleteUser ?? false },
        warnings,
      };
    }
    case 'terminate_plan': {
      const userId = pathSegment(change.userId, 'userId');
      assertTerminationDate(change.terminationDate, now);
      const plan = await client.get<Record<string, unknown>>(`/v1/user-plans/${userId}`);
      warnings.push('Ends every line on the plan; the numbers are released and cannot be recovered through this server.');
      if (change.deleteUser) warnings.push('deleteUser=true also deletes the user once the plan has ended.');
      return {
        steps: [
          {
            method: 'POST',
            path: `/v1/user-plans/${userId}/termination`,
            body: { terminationDate: change.terminationDate, ...(change.deleteUser === undefined ? {} : { deleteUser: change.deleteUser }) },
          },
        ],
        preview: { plan: summarizePlan(plan), terminationDate: change.terminationDate, deleteUser: change.deleteUser ?? false },
        warnings,
      };
    }
    case 'delete_user': {
      const userId = pathSegment(change.userId, 'userId');
      const plan = await userPlanOrNull(client, userId);
      if (plan && !['INACTIVE'].includes(String(plan.status))) {
        warnings.push(`The user still has a plan in status ${String(plan.status)}; terminate it first (terminate_plan with deleteUser=true does both).`);
      }
      return {
        steps: [{ method: 'DELETE', path: `/v1/users/${userId}` }],
        preview: { userId: change.userId, plan: summarizePlan(plan) },
        warnings,
      };
    }
    case 'submit_port_in': {
      pathSegment(change.userId, 'userId');
      const countryCode = upperCountry(change.countryCode);
      const validation = await client.send<{ valid?: boolean; errors?: unknown[] }>('POST', '/v1/port-ins/validate', {
        body: {
          countryCode,
          type: change.type,
          msisdn: change.msisdn,
          executionDate: change.executionDate,
          fields: change.fields,
        },
      });
      if (validation?.valid === false) {
        throw new Error(`Telgea rejected the port-in data; fix these and prepare again: ${JSON.stringify(validation.errors ?? [])}`);
      }
      const plan = await userPlanOrNull(client, pathSegment(change.userId, 'userId'));
      warnings.push(
        'Submitting asks the current operator to release the number on the execution date. The subscriber’s contract with that operator may carry fees or a notice period.',
      );
      return {
        steps: [
          {
            method: 'POST',
            path: '/v1/port-ins',
            body: {
              userId: change.userId,
              countryCode,
              msisdn: change.msisdn,
              executionDate: change.executionDate,
              type: change.type,
              fields: change.fields,
            },
          },
        ],
        preview: {
          user: summarizePlan(plan),
          msisdn: change.msisdn,
          countryCode,
          type: change.type,
          executionDate: change.executionDate,
          fieldNames: Object.keys(change.fields).sort(),
          validation: 'passed',
        },
        warnings,
      };
    }
    case 'discard_port_in': {
      const portInId = pathSegment(change.portInId, 'portInId');
      const portIn = await client.get<Record<string, unknown>>(`/v1/port-ins/${portInId}`);
      if (!['FAILED', 'REJECTED'].includes(String(portIn.status))) {
        warnings.push(`Port-in status is ${String(portIn.status)}; Telgea only discards failed port-ins and will likely refuse.`);
      }
      return {
        steps: [{ method: 'POST', path: `/v1/port-ins/${portInId}/discard` }],
        preview: { portIn },
        warnings,
      };
    }
    default: {
      const unknownKind: never = change;
      throw new Error(`Unsupported change kind: ${JSON.stringify(unknownKind)}`);
    }
  }
}

const ALLOWED_STEPS: Array<{ method: OperationStep['method']; pattern: RegExp }> = [
  { method: 'POST', pattern: /^\/v1\/user-plans$/ },
  { method: 'POST', pattern: /^\/v1\/numbers$/ },
  { method: 'POST', pattern: /^\/v1\/numbers\/[^/?#%]+\/sim-replacement$/ },
  { method: 'POST', pattern: /^\/v1\/numbers\/[^/?#%]+\/termination$/ },
  { method: 'POST', pattern: /^\/v1\/user-plans\/[^/?#%]+\/termination$/ },
  { method: 'DELETE', pattern: /^\/v1\/users\/[^/?#%]+$/ },
  { method: 'POST', pattern: /^\/v1\/port-ins$/ },
  { method: 'POST', pattern: /^\/v1\/port-ins\/[^/?#%]+\/discard$/ },
];

export function assertAllowedStep(step: OperationStep): void {
  const ok = ALLOWED_STEPS.some(rule => rule.method === step.method && rule.pattern.test(step.path));
  if (!ok || step.path.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error(`Step is not allowlisted for prepared operations: ${step.method} ${step.path}`);
  }
}

function sign(unsigned: Omit<PreparedOperation, 'operationHash'>): string {
  return createHmac('sha256', secret()).update(canonicalJson(unsigned)).digest('hex');
}

/** JSON with sorted keys, so a client re-serialising the object does not break the signature. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

async function userPlanOrNull(client: TelgeaClient, encodedUserId: string): Promise<Record<string, unknown> | null> {
  try {
    return await client.get<Record<string, unknown>>(`/v1/user-plans/${encodedUserId}`);
  } catch (error) {
    if (error instanceof TelgeaHttpError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

function summarizePlan(plan: Record<string, unknown> | null): unknown {
  if (!plan) return null;
  return {
    userId: plan.userId,
    name: [plan.firstName, plan.lastName].filter(Boolean).join(' '),
    email: plan.email,
    status: plan.status,
    teamId: plan.teamId,
    localNumber: summarizeLine(plan.localNumber as Record<string, unknown> | undefined),
    travelNumber: summarizeLine(plan.travelNumber as Record<string, unknown> | undefined),
  };
}

function summarizeLine(line: Record<string, unknown> | null | undefined): unknown {
  if (!line) return null;
  const sim = line.sim as Record<string, unknown> | undefined;
  return {
    id: line.id,
    type: line.type,
    phoneNumber: line.phoneNumber,
    countryCode: line.countryCode,
    state: line.state,
    userId: line.userId,
    iccid: sim?.iccid,
  };
}

function upperCountry(code: string): string {
  const value = String(code ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) {
    throw new Error(`countryCode must be an ISO 3166-1 alpha-2 code such as DK, got ${JSON.stringify(code)}.`);
  }
  return value;
}

function assertTerminationDate(date: string, now: Date): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error(`terminationDate must be YYYY-MM-DD, got ${JSON.stringify(date)}.`);
  }
  const today = now.toISOString().slice(0, 10);
  if (date < today) {
    throw new Error(`terminationDate ${date} is in the past.`);
  }
}

export function previewForAudit(operation: PreparedOperation): unknown {
  return { kind: operation.kind, steps: operation.steps.map(step => `${step.method} ${step.path}`) };
}
