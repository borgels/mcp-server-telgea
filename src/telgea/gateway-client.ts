import { randomUUID } from 'node:crypto';
import type { SecretRedactor } from '../upstream-http.js';

/**
 * The client of the embedded gateway (src/gateway.ts). Unlike TelgeaClient
 * (the MCP server's), it reads no TELGEA_* variable: the key and the time
 * limit come from the host only, the address is fixed (TELGEA_API_ORIGIN),
 * the key goes to the instance's redactor instead of the process-wide
 * registry, redirects are never followed, the body of an error answer is
 * never read, and an answer that is not JSON is refused. It keeps no cache
 * and no request budget of its own: an instance may live for one call only.
 */

/** The only address an embedded client talks to. */
export const TELGEA_API_ORIGIN = 'https://api.telgea.com';

/** Largest successful JSON answer an embedded client reads. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 30_000;

export type GatewayQueryValue = string | number | boolean | null | undefined;

/** Our own guidance per HTTP status. */
const STATUS_HINTS: Record<number, string> = {
  400: 'Telgea refused the values. Check the ids and values.',
  401: 'Telgea rejected the API key (invalid or revoked). Retrying will not help.',
  403: 'The Telgea API key has no permission for this. Retrying will not help.',
  404: 'Telgea found nothing with this id. Check the ids.',
  409: 'Telgea refused the change in the current state of the line or plan.',
  422: 'Telgea refused the values. Check the ids and values.',
  429: 'Telgea is throttling requests (each key allows 1000 requests per day). Wait and retry later.',
};

/** System error codes a network error may name: a fixed list, so no other text from a cause is ever shown. */
const SHOWN_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** An HTTP error from Telgea in our own words: the status, our hint and a retry-after; never Telgea's body. */
export class TelgeaGatewayHttpError extends Error {
  readonly status: number;
  constructor(status: number, method: string, retryAfter?: string) {
    const hint = Object.hasOwn(STATUS_HINTS, status) ? ` ${STATUS_HINTS[status]}` : '';
    const wait = retryAfter ? ` Retry after ${retryAfter} seconds.` : '';
    super(`Telgea API request failed with HTTP ${status} (${method}).${hint}${wait}`);
    this.name = 'TelgeaHttpError';
    this.status = status;
  }
}

export interface TelgeaGatewayClientOptions {
  apiKey: string;
  redactor: SecretRedactor;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class TelgeaGatewayClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;

  constructor(options: TelgeaGatewayClientOptions) {
    this.apiKey = options.apiKey;
    options.redactor.addSecret(this.apiKey);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
    }
  }

  get<T>(path: string, query?: Record<string, GatewayQueryValue>): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return this.request<T>(method, path, undefined, body);
  }

  /** The URL of a path under /v1/ on the fixed address. */
  buildUrl(path: string, query?: Record<string, GatewayQueryValue>): string {
    if (!path.startsWith('/v1/')) {
      throw new Error('Refusing to call a path outside /v1/.');
    }
    const url = new URL(`${TELGEA_API_ORIGIN}${path}`);
    if (url.origin !== TELGEA_API_ORIGIN || url.pathname !== path) {
      throw new Error('Refusing to call a path outside /v1/.');
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    query?: Record<string, GatewayQueryValue>,
    body?: unknown,
  ): Promise<T> {
    const url = this.buildUrl(path, query);
    const headers: Record<string, string> = {
      Accept: 'application/json, application/problem+json',
      'x-api-key': this.apiKey,
    };
    if (method !== 'GET') {
      // Telgea replays the first outcome for the same key; ours is fresh per request.
      headers['Idempotency-Key'] = randomUUID();
    }
    const init: RequestInit = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw this.transportError(method, error);
    }

    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await discard(response);
      throw new Error(`Telgea API responded with a redirect (HTTP ${response.status}) for ${method}; redirects are not followed.`);
    }
    if (!response.ok) {
      // The body is never read: Telgea's text never becomes part of an error.
      await discard(response);
      throw new TelgeaGatewayHttpError(response.status, method, wholeNumber(response.headers.get('retry-after')));
    }

    let read: { bytes: Uint8Array; exceeded: boolean };
    try {
      read = await readUpTo(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      throw this.transportError(method, error);
    }
    if (read.exceeded) {
      throw new Error(`The Telgea answer exceeds the ${MAX_RESPONSE_BYTES} byte limit (${method}).`);
    }
    const text = new TextDecoder().decode(read.bytes);
    if (!text.trim()) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Telgea answered with something that is not JSON (${method}); nothing of it is passed on.`);
    }
  }

  /** A network failure or timeout in our own words: no cause text, only a code from a fixed list. */
  private transportError(method: string, error: unknown): Error {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return Object.assign(new Error(`Telgea API request timed out after ${this.timeoutMs} ms (${method}).`), {
        name: 'TimeoutError',
      });
    }
    const shown = causeCodes(error).find(code => SHOWN_NETWORK_CODES.has(code));
    return new Error(`Network error calling the Telgea API (${method})${shown ? ` (${shown})` : ''}.`);
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

function causeCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

/** A header value that is a whole number of at most 9 digits; anything else is dropped. */
function wholeNumber(value: string | null): string | undefined {
  return value !== null && /^\d{1,9}$/.test(value.trim()) ? value.trim() : undefined;
}

async function readUpTo(response: Response, limit: number): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), exceeded: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > limit) {
      exceeded = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded };
}
