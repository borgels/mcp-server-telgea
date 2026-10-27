import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertAllowedStep,
  canonicalJson,
  commitPreparedOperation,
  prepareChange,
  verifyPreparedOperation,
} from '../src/telgea/operations.js';
import { fakeTelgea, LINE, NUMBER_ID, PLAN, problem, USER_ID } from './helpers.js';

const NOW = new Date('2026-10-27T12:00:00Z');

beforeEach(() => {
  process.env.TELGEA_ENABLE_WRITES = 'true';
});
afterEach(() => {
  delete process.env.TELGEA_ENABLE_WRITES;
});

describe('prepare / commit', () => {
  it('previews a termination without sending it, then commits with a hash-derived idempotency key', async () => {
    const { client, seen } = fakeTelgea(request =>
      request.method === 'GET' ? PLAN : { terminationDate: '2026-12-31', activeUntil: '2026-12-31', numberIds: [NUMBER_ID] },
    );
    const operation = await prepareChange(
      client,
      { kind: 'terminate_plan', userId: USER_ID, terminationDate: '2026-12-31', deleteUser: true },
      { reason: 'Leaving', actingAs: 'alice@example.com', now: NOW },
    );
    expect(seen.map(r => r.method)).toEqual(['GET']);
    expect(operation.steps).toEqual([
      { method: 'POST', path: `/v1/user-plans/${USER_ID}/termination`, body: { terminationDate: '2026-12-31', deleteUser: true } },
    ]);
    expect(JSON.stringify(operation.preview)).not.toContain('SECRET');
    expect(operation.warnings.join(' ')).toMatch(/deletes the user/);

    // A client re-serialising the object with other key order must still verify.
    const roundTripped = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(operation).reverse())));
    verifyPreparedOperation(roundTripped, {
      confirmOperationHash: operation.operationHash,
      actingAs: 'alice@example.com',
      now: NOW,
    });

    const result = await commitPreparedOperation(client, operation);
    expect(result.status).toBe('applied');
    const post = seen[1]!;
    expect(post.method).toBe('POST');
    expect(post.headers['Idempotency-Key']).toBe(`mcp-${operation.operationHash.slice(0, 48)}-1`);

    await commitPreparedOperation(client, operation);
    expect(seen[2]!.headers['Idempotency-Key']).toBe(post.headers['Idempotency-Key']);
  });

  it('rejects tampering, a wrong hash, expiry and another user', async () => {
    const { client } = fakeTelgea(() => LINE);
    const operation = await prepareChange(
      client,
      { kind: 'replace_sim', numberId: NUMBER_ID },
      { reason: 'Broken phone', actingAs: 'alice@example.com', now: NOW },
    );
    const ok = { confirmOperationHash: operation.operationHash, actingAs: 'alice@example.com', now: NOW };

    const tampered = { ...operation, steps: [{ method: 'DELETE' as const, path: `/v1/users/${USER_ID}` }] };
    expect(() => verifyPreparedOperation(tampered, ok)).toThrow(/signature/);
    expect(() => verifyPreparedOperation(operation, { ...ok, confirmOperationHash: 'abc' })).toThrow(/confirmOperationHash/);
    expect(() => verifyPreparedOperation(operation, { ...ok, now: new Date(NOW.getTime() + 16 * 60_000) })).toThrow(/expired/);
    expect(() => verifyPreparedOperation(operation, { ...ok, actingAs: 'mallory@example.com' })).toThrow(/another user/);
    expect(() => verifyPreparedOperation(operation, ok)).not.toThrow();
  });

  it('refuses to prepare when writes are disabled', async () => {
    delete process.env.TELGEA_ENABLE_WRITES;
    const { client, seen } = fakeTelgea(() => LINE);
    await expect(
      prepareChange(client, { kind: 'replace_sim', numberId: NUMBER_ID }, { reason: 'x', actingAs: 'a' }),
    ).rejects.toThrow(/TELGEA_ENABLE_WRITES/);
    expect(seen).toHaveLength(0);
  });

  it('refuses a termination date in the past', async () => {
    const { client } = fakeTelgea(() => PLAN);
    await expect(
      prepareChange(
        client,
        { kind: 'terminate_plan', userId: USER_ID, terminationDate: '2026-01-01' },
        { reason: 'x', actingAs: 'a', now: NOW },
      ),
    ).rejects.toThrow(/past/);
  });

  it('validates a port-in with Telgea before preparing it, and stops on invalid data', async () => {
    const { client } = fakeTelgea(request =>
      request.url.endsWith('/validate') ? { valid: false, errors: [{ field: 'accountNumber', code: 'REQUIRED', message: 'Required' }] } : PLAN,
    );
    await expect(
      prepareChange(
        client,
        { kind: 'submit_port_in', userId: USER_ID, countryCode: 'dk', msisdn: '+4511223344', executionDate: '2026-12-01', type: 'business', fields: {} },
        { reason: 'Port number', actingAs: 'a', now: NOW },
      ),
    ).rejects.toThrow(/accountNumber/);
  });

  it('notes a missing plan instead of failing when creating one', async () => {
    const { client } = fakeTelgea(() => problem(404, 'NOT_FOUND', 'No plan'));
    const operation = await prepareChange(
      client,
      { kind: 'create_user_plan', userId: USER_ID, countryCode: 'dk' },
      { reason: 'New hire', actingAs: 'a', now: NOW },
    );
    expect(operation.steps[0]).toEqual({ method: 'POST', path: '/v1/user-plans', body: { userId: USER_ID, countryCode: 'DK' } });
  });

  it('reports a failed commit step', async () => {
    const { client } = fakeTelgea(request => (request.method === 'GET' ? LINE : problem(409, 'CONFLICT', 'Already replacing')));
    const operation = await prepareChange(client, { kind: 'replace_sim', numberId: NUMBER_ID }, { reason: 'x', actingAs: 'a', now: NOW });
    const result = await commitPreparedOperation(client, operation);
    expect(result.status).toBe('failed');
    expect(result.results[0]!.error).toContain('Already replacing');
  });
});

describe('step allowlist', () => {
  it('allows only the prepared-operation endpoints', () => {
    expect(() => assertAllowedStep({ method: 'POST', path: `/v1/numbers/${NUMBER_ID}/termination` })).not.toThrow();
    expect(() => assertAllowedStep({ method: 'DELETE', path: `/v1/teams/${USER_ID}` })).toThrow();
    expect(() => assertAllowedStep({ method: 'POST', path: '/v1/numbers/../users/termination' })).toThrow();
    expect(() => assertAllowedStep({ method: 'PATCH', path: `/v1/users/${USER_ID}` })).toThrow();
  });
});

describe('canonicalJson', () => {
  it('is independent of key order and skips undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe(canonicalJson({ a: { d: 2 }, b: 1 }));
  });
});
