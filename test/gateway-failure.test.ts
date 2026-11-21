// Failure metadata on gateway error results: Telgea's HTTP status and its request id (a UUID or hex id only), for a
// host that counts failures without reading their text. Never the body, Telgea's code or message.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failureMetadata, requestIdFrom, TelgeaAnswerError, vendorRequestId } from '../src/errors.js';
import { createTelgeaGateway } from '../src/gateway.js';
import { TelgeaGatewayHttpError } from '../src/telgea/gateway-client.js';

const TOKEN = 'qqqqwwwwzzzzxxxx1';
const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const LINE_ID = '22222222-2222-4222-8222-222222222222';
const BODY = { title: 'Line of Jane Doe not found', code: 'E_NOPE', requestId: 'abcdef12-3456-7890' };

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/problem+json', ...headers } });
}

function gatewayFetching(fetchImpl: typeof fetch, apiKey = TOKEN) {
  return createTelgeaGateway({ apiKey, fetchImpl });
}

function gatewayAnswering(status: number, headers: Record<string, string>, body: unknown = BODY, apiKey = TOKEN) {
  return gatewayFetching((async () => json(body, status, headers)) as typeof fetch, apiKey);
}

describe('vendorRequestId', () => {
  it('keeps a UUID and a hex id', () => {
    expect(vendorRequestId(UUID)).toBe(UUID);
    expect(vendorRequestId(` ${UUID} `)).toBe(UUID);
    expect(vendorRequestId('a1b2c3d4e5f60718')).toBe('a1b2c3d4e5f60718');
    expect(vendorRequestId('ABCDEF12-3456')).toBe('ABCDEF12-3456');
    expect(vendorRequestId('f'.repeat(64))).toBe('f'.repeat(64));
  });

  it('drops anything that could be text, and the shape of a personal number', () => {
    for (const value of [
      undefined,
      null,
      '',
      'abc123',
      'Jane Doe',
      'jane@example.com',
      'req_8f3a9c2d1e',
      'deadbeef deadbeef',
      '0101901234',
      'ab-010190-1234-cd',
      'f'.repeat(65),
      '-abcdef12',
      'abcdef12-',
      'a-------',
      'abc--def',
      'abcd--ef12',
      'abcdef12-ab',
      'abcdef1',
      'abcdef12-'.repeat(8),
    ]) {
      expect(vendorRequestId(value)).toBeUndefined();
    }
  });

  it('reads the first header that has an id in the right form', () => {
    expect(requestIdFrom(new Headers({ 'x-request-id': 'not an id', 'request-id': UUID }))).toBe(UUID);
    expect(requestIdFrom(new Headers({ 'x-correlation-id': 'deadbeefcafe' }))).toBe('deadbeefcafe');
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }))).toBeUndefined();
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }), ['x-vendor-id'])).toBe(UUID);
  });

  it('gives metadata for an answer from Telgea only', () => {
    expect(failureMetadata(new TelgeaGatewayHttpError(404, 'GET', undefined, UUID))).toEqual({ httpStatus: 404, requestId: UUID });
    expect(failureMetadata(new TelgeaGatewayHttpError(500, 'GET', undefined, 'Jane Doe'))).toEqual({ httpStatus: 500 });
    expect(failureMetadata(new TelgeaAnswerError('redirect', 302, UUID))).toEqual({ httpStatus: 302, requestId: UUID });
    expect(failureMetadata(new Error('boom'))).toBeUndefined();
    expect(failureMetadata('boom')).toBeUndefined();
  });
});

describe('gateway error results', () => {
  it('carry the HTTP status and the request id, never the body', async () => {
    const result = await gatewayAnswering(404, { 'x-request-id': UUID }).callTool('get_line', { numberId: LINE_ID });
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 404, requestId: UUID });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('Jane Doe');
    expect(serialised).not.toContain('E_NOPE');
  });

  it('never take the request id from the body', async () => {
    const result = await gatewayAnswering(404, {}).callTool('get_line', { numberId: LINE_ID });
    expect(result.failure).toEqual({ httpStatus: 404 });
    expect(JSON.stringify(result)).not.toContain(BODY.requestId);
  });

  it('carry the status and request id of a refused redirect', async () => {
    const gw = gatewayFetching(
      (async () =>
        new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.test/', 'x-request-id': UUID } })) as typeof fetch,
    );
    const result = await gw.callTool('get_line', { numberId: LINE_ID });
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 302, requestId: UUID });
    expect(JSON.stringify(result)).not.toContain('elsewhere');
  });

  it('carry the status alone when the request id is not in the form of one', async () => {
    const result = await gatewayAnswering(422, { 'x-request-id': 'Jane Doe <jane@example.com>' }).callTool('get_line', {
      numberId: LINE_ID,
    });
    expect(result.failure).toEqual({ httpStatus: 422 });
    expect(JSON.stringify(result)).not.toContain('jane@example.com');
  });

  it('drop a request id that holds a piece of the key', async () => {
    // The key's own hex-looking piece as the id: redaction changes it, and the changed value is no id.
    const result = await gatewayAnswering(500, { 'x-request-id': 'deadbeef00112233' }, {}, 'deadbeef00112233-key-0').callTool(
      'get_line',
      { numberId: LINE_ID },
    );
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 500 });
    expect(JSON.stringify(result)).not.toContain('deadbeef0011');
  });

  it('have no metadata when the cause is not an answer from Telgea', async () => {
    const gw = gatewayAnswering(200, {}, { id: LINE_ID });
    expect((await gw.callTool('get_line', {})).failure).toBeUndefined();
    expect((await gw.callTool('no_such_tool', {})).failure).toBeUndefined();
    const offline = gatewayFetching((async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    const result = await offline.callTool('get_line', { numberId: LINE_ID });
    expect(result.isError).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  it('are absent on a successful result', async () => {
    const result = await gatewayAnswering(200, { 'x-request-id': UUID }, { id: LINE_ID, phoneNumber: '+4512345678' }).callTool(
      'get_line',
      { numberId: LINE_ID },
    );
    expect(result.isError).toBeUndefined();
    expect(result.failure).toBeUndefined();
  });
});
