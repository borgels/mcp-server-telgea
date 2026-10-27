import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redactSecrets, TelgeaHttpError } from '../src/errors.js';
import { RequestBudget } from '../src/telgea/budget.js';
import { pathSegment, TelgeaClient } from '../src/telgea/client.js';
import { redactSimSecrets } from '../src/telgea/redact.js';
import { fakeTelgea, LINE, problem } from './helpers.js';

describe('TelgeaClient', () => {
  it('sends x-api-key and builds /v1 URLs, skipping empty query values', async () => {
    const { client, seen } = fakeTelgea(() => ({ items: [] }));
    await client.get('/v1/numbers', { userId: 'abc', state: undefined, msisdn: '' });
    expect(seen[0]!.url).toBe('https://api.telgea.com/v1/numbers?userId=abc');
    expect(seen[0]!.headers['x-api-key']).toBe('test-key');
    expect(seen[0]!.headers['Idempotency-Key']).toBeUndefined();
  });

  it('refuses paths outside /v1/', async () => {
    const { client } = fakeTelgea(() => ({}));
    await expect(client.get('/admin')).rejects.toThrow(/outside \/v1/);
  });

  it('adds an Idempotency-Key to writes and honours a given one', async () => {
    const { client, seen } = fakeTelgea(() => ({ id: 'x' }));
    await client.send('POST', '/v1/teams', { body: { name: 'A' } });
    await client.send('POST', '/v1/teams', { body: { name: 'B' }, idempotencyKey: 'fixed-key' });
    expect(seen[0]!.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1]!.headers['Idempotency-Key']).toBe('fixed-key');
    expect(seen[1]!.body).toEqual({ name: 'B' });
    await expect(client.send('POST', '/v1/teams', { idempotencyKey: 'bad key' })).rejects.toThrow(/Idempotency key/);
  });

  it('caches GETs and drops the cache on any write', async () => {
    const { fetchImpl } = fakeTelgea(() => ({ items: [] }));
    const client = new TelgeaClient({ apiKey: 'k', fetchImpl, cacheTtlMs: 60_000, budget: new RequestBudget(100) });
    await client.get('/v1/teams');
    await client.get('/v1/teams');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await client.send('POST', '/v1/teams', { body: { name: 'x' } });
    await client.get('/v1/teams');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries a 503 once', async () => {
    let calls = 0;
    const { client } = fakeTelgea(() => (++calls === 1 ? problem(503, 'UNAVAILABLE', 'down') : { ok: true }));
    await expect(client.get('/v1/teams')).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('turns problem+json into a readable error with code and requestId', async () => {
    const { client } = fakeTelgea(() => problem(409, 'CONFLICT', 'Line is already suspended.'));
    const error = (await client.send('POST', '/v1/numbers/x/suspension').catch(e => e)) as TelgeaHttpError;
    expect(error).toBeInstanceOf(TelgeaHttpError);
    expect(error.status).toBe(409);
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain('Line is already suspended.');
    expect(error.message).toContain('requestId=req-1');
  });

  it('fails before sending without an API key', async () => {
    const saved = process.env.TELGEA_API_KEY;
    delete process.env.TELGEA_API_KEY;
    const { fetchImpl } = fakeTelgea(() => ({}));
    const client = new TelgeaClient({ fetchImpl, budget: new RequestBudget(10) });
    await expect(client.get('/v1/teams')).rejects.toThrow('TELGEA_API_KEY');
    expect(fetchImpl).not.toHaveBeenCalled();
    if (saved !== undefined) process.env.TELGEA_API_KEY = saved;
  });

  it('refuses to send the key over plain http to a remote host, or to a base URL with a path', () => {
    expect(() => new TelgeaClient({ apiKey: 'k', baseUrl: 'http://api.example.com' })).toThrow(/https/);
    expect(() => new TelgeaClient({ apiKey: 'k', baseUrl: 'https://api.example.com/v1' })).toThrow(/without a path/);
    expect(() => new TelgeaClient({ apiKey: 'k', baseUrl: 'http://127.0.0.1:9999' })).not.toThrow();
  });

  it('redacts API keys from messages', () => {
    expect(redactSecrets('x-api-key: abc123 failed')).not.toContain('abc123');
    expect(redactSecrets('TELGEA_API_KEY=abc123')).not.toContain('abc123');
  });
});

describe('pathSegment', () => {
  it('encodes ids and rejects anything that changes the path', () => {
    expect(pathSegment('11111111-1111-4111-8111-111111111111')).toBe('11111111-1111-4111-8111-111111111111');
    for (const bad of ['', ' ', '.', '..', 'a/b', 'a\\b', 'a?b', 'a#b', '%2e%2e', 'a\nb']) {
      expect(() => pathSegment(bad)).toThrow(/Invalid/);
    }
  });
});

describe('RequestBudget', () => {
  it('refuses locally once the limit is reached and frees slots after 24 hours', () => {
    let now = Date.parse('2026-10-01T00:00:00Z');
    const budget = new RequestBudget(2, undefined, () => now);
    budget.consume();
    budget.consume();
    expect(() => budget.consume()).toThrow(/budget exhausted/);
    expect(budget.status()).toMatchObject({ used: 2, remaining: 0 });
    now += 24 * 60 * 60 * 1000 + 1;
    expect(() => budget.consume()).not.toThrow();
    expect(budget.status().used).toBe(1);
  });

  it('persists the window across restarts when a state file is set', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'telgea-budget-')), 'budget.json');
    const first = new RequestBudget(5, path);
    first.consume();
    first.consume();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(2);
    expect(new RequestBudget(5, path).status().used).toBe(2);
  });

  it('counts every request the client sends, including a 503 retry', async () => {
    const budget = new RequestBudget(1);
    const { fetchImpl } = fakeTelgea(() => problem(503, 'UNAVAILABLE', 'down'));
    const client = new TelgeaClient({ apiKey: 'k', fetchImpl, budget, retryDelayMs: 0, cacheTtlMs: 0 });
    await expect(client.get('/v1/teams')).rejects.toThrow(/budget exhausted/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('redactSimSecrets', () => {
  it('strips activation code and PIN/PUK wherever a sim object appears, keeping the ICCID', () => {
    const redacted = redactSimSecrets({ items: [LINE], plan: { localNumber: LINE } });
    const text = JSON.stringify(redacted);
    for (const secret of ['SECRET', '1234', '5678', '11112222', '33334444']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain(LINE.sim.iccid);
    expect(LINE.sim.pinOne).toBe('1234');
  });
});
