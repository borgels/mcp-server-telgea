import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestBudget } from '../src/telgea/budget.js';
import { TelgeaClient } from '../src/telgea/client.js';
import { PACKAGE_VERSION } from '../src/version.js';

const KEY = 'telgea-test-key-0123456789';

function client(fetchImpl: typeof fetch): TelgeaClient {
  return new TelgeaClient({ apiKey: KEY, fetchImpl, cacheTtlMs: 0, budget: new RequestBudget(100) });
}

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

describe('Telgea client hardening', () => {
  it('never follows redirects, so x-api-key stays on the API origin', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/x' } });
    });
    await expect(client(fetchImpl as typeof fetch).get('/v1/lines', { query: 'q' })).rejects.toThrow(
      /redirect \(HTTP 307\).*redirects are not followed/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('redacts the key before truncating error text and drops query strings', async () => {
    const body = `${'x'.repeat(490)} key ${KEY} ${'y'.repeat(200_000)}`;
    const fetchImpl = vi.fn(async () => new Response(body, { status: 500 }));
    const error: Error & { url: string } = await client(fetchImpl as typeof fetch)
      .get('/v1/lines', { query: 'secret-query' })
      .then(
        () => {
          throw new Error('expected failure');
        },
        (e: unknown) => e as Error & { url: string },
      );
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain(KEY.slice(0, 10));
    expect(error.message.length).toBeLessThan(2_000);
    expect(error.url).not.toContain('secret-query');
  });

  it('rejects an invalid TELGEA_TIMEOUT_MS instead of using NaN', () => {
    process.env.TELGEA_TIMEOUT_MS = 'abc';
    expect(() => new TelgeaClient()).toThrow(/TELGEA_TIMEOUT_MS/);
    process.env.TELGEA_TIMEOUT_MS = '-1';
    expect(() => new TelgeaClient()).toThrow(/TELGEA_TIMEOUT_MS/);
    process.env.TELGEA_TIMEOUT_MS = '5000';
    expect(() => new TelgeaClient()).not.toThrow();
  });

  it('reports the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});

describe('Telgea request budget configuration', () => {
  it('rejects a malformed TELGEA_DAILY_REQUEST_BUDGET instead of disabling the budget', () => {
    for (const value of ['abc', '0', '-5', '1.5', '1e3']) {
      expect(() => RequestBudget.fromEnv({ TELGEA_DAILY_REQUEST_BUDGET: value }), value).toThrow(
        /TELGEA_DAILY_REQUEST_BUDGET/,
      );
    }
    expect(RequestBudget.fromEnv({}).limit).toBe(1000);
    expect(RequestBudget.fromEnv({ TELGEA_DAILY_REQUEST_BUDGET: '' }).limit).toBe(1000);
    expect(RequestBudget.fromEnv({ TELGEA_DAILY_REQUEST_BUDGET: '250' }).limit).toBe(250);
  });

  it('still enforces the budget', () => {
    const budget = RequestBudget.fromEnv({ TELGEA_DAILY_REQUEST_BUDGET: '2' });
    budget.consume();
    budget.consume();
    expect(() => budget.consume()).toThrow(/budget exhausted/);
  });
});
