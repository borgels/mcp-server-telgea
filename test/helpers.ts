import { vi } from 'vitest';
import { RequestBudget } from '../src/telgea/budget.js';
import { TelgeaClient } from '../src/telgea/client.js';

export interface SeenRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

type Handler = (request: SeenRequest) => Response | unknown;

export function fakeTelgea(handler: Handler) {
  const seen: SeenRequest[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request: SeenRequest = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    seen.push(request);
    const result = handler(request);
    if (result instanceof Response) {
      return result;
    }
    if (result === undefined) {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const client = new TelgeaClient({
    apiKey: 'test-key',
    fetchImpl,
    cacheTtlMs: 0,
    retryDelayMs: 0,
    budget: new RequestBudget(1000),
  });
  return { client, seen, fetchImpl };
}

export function problem(status: number, code: string, detail: string): Response {
  return new Response(
    JSON.stringify({ type: `https://developer.telgea.com/errors/http/${code}`, title: code, status, detail, code, requestId: 'req-1' }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

export const USER_ID = '11111111-1111-4111-8111-111111111111';
export const NUMBER_ID = '22222222-2222-4222-8222-222222222222';

export const LINE = {
  id: NUMBER_ID,
  type: 'local',
  countryCode: 'DK',
  phoneNumber: '+4511223344',
  state: 'READY',
  sim: {
    iccid: '8945000000000000001',
    activationCode: 'LPA:1$smdp.example$SECRET',
    pinOne: '1234',
    pinTwo: '5678',
    pukOne: '11112222',
    pukTwo: '33334444',
  },
  userId: USER_ID,
  createdAt: '2026-01-01T00:00:00Z',
};

export const PLAN = {
  userId: USER_ID,
  email: 'jane@example.com',
  firstName: 'Jane',
  lastName: 'Doe',
  status: 'ACTIVE',
  teamId: '33333333-3333-4333-8333-333333333333',
  localNumber: LINE,
  travelNumber: null,
};
