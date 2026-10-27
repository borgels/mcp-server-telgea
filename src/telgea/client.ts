import { randomUUID } from 'node:crypto';
import { TelgeaHttpError } from '../errors.js';
import { RequestBudget } from './budget.js';

export interface TelgeaClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** GET responses are reused for this long (ms). 0 disables the cache. */
  cacheTtlMs?: number;
  budget?: RequestBudget;
  /** Wait before the single retry of a 503 (ms). */
  retryDelayMs?: number;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /**
   * Idempotency-Key for a state-changing request. Telgea replays the original
   * outcome for the same key on the same endpoint for 24 hours, so a retry is
   * safe. One is generated when omitted.
   */
  idempotencyKey?: string;
}

const IDEMPOTENCY_KEY = /^[!-~]{1,255}$/;

/**
 * Client for the Telgea Open API (https://api.telgea.com/v1). Auth is one
 * organisation-scoped key in the x-api-key header. Each key allows 1000
 * requests per 24 hours across every endpoint, so the client counts its own
 * requests (RequestBudget) and briefly caches GETs.
 */
export class TelgeaClient {
  private readonly apiKey?: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly retryDelayMs: number;
  readonly budget: RequestBudget;
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(options: TelgeaClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TELGEA_API_KEY;
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? process.env.TELGEA_BASE_URL ?? 'https://api.telgea.com');
    assertSafeBaseUrl(this.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.TELGEA_TIMEOUT_MS ?? 30_000);
    this.cacheTtlMs = options.cacheTtlMs ?? Number(process.env.TELGEA_CACHE_TTL_MS ?? 60_000);
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.budget = options.budget ?? RequestBudget.fromEnv();
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  async send<T>(method: Exclude<HttpMethod, 'GET'>, path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(method, path, options);
  }

  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    if (!path.startsWith('/v1/')) {
      throw new Error(`Refusing to call a path outside /v1/: ${path}`);
    }
    const url = new URL(`${this.baseUrl}${path}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') {
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    return url.toString();
  }

  clearCache(): void {
    this.cache.clear();
  }

  private async request<T>(method: HttpMethod, path: string, options: RequestOptions): Promise<T> {
    if (!this.apiKey) {
      throw new Error('Missing TELGEA_API_KEY. Set it in the MCP server environment.');
    }

    const url = this.buildUrl(path, options.query);

    if (method === 'GET' && this.cacheTtlMs > 0) {
      const hit = this.cache.get(url);
      if (hit && Date.now() - hit.at < this.cacheTtlMs) {
        return structuredClone(hit.value) as T;
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json, application/problem+json',
      'x-api-key': this.apiKey,
    };

    if (method !== 'GET') {
      const key = options.idempotencyKey ?? randomUUID();
      if (!IDEMPOTENCY_KEY.test(key)) {
        throw new Error('Idempotency key must be 1-255 printable ASCII characters.');
      }
      headers['Idempotency-Key'] = key;
      // Any change may invalidate what a cached read says.
      this.cache.clear();
    }

    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    // GETs and keyed writes are safe to repeat; a 503 gets one retry.
    let response = await this.fetchOnce(url, init);
    if (response.status === 503) {
      await delay(this.retryDelayMs);
      response = await this.fetchOnce(url, init);
    }

    const responseBody = await readResponseBody(response);

    if (!response.ok) {
      throw new TelgeaHttpError({
        status: response.status,
        url,
        payload: responseBody,
        retryAfter: response.headers.get('retry-after') ?? undefined,
      });
    }

    if (method === 'GET' && this.cacheTtlMs > 0) {
      this.cache.set(url, { at: Date.now(), value: structuredClone(responseBody) });
    }

    return responseBody as T;
  }

  private async fetchOnce(url: string, init: RequestInit): Promise<Response> {
    this.budget.consume();
    return this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
  }
}

/**
 * One URL path segment from a caller-supplied id. Rejects anything that could
 * change which endpoint is hit (separators, dot segments, query/fragment,
 * percent-encoding) before it is encoded.
 */
export function pathSegment(value: string, name = 'id'): string {
  const trimmed = String(value ?? '').trim();
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed === '..' ||
    /[/\\?#%]/.test(trimmed) ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    throw new Error(`Invalid ${name}: ${JSON.stringify(value)}`);
  }
  return encodeURIComponent(trimmed);
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    return text;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

function assertSafeBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`TELGEA_BASE_URL is not a valid URL: ${baseUrl}`);
  }

  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('TELGEA_BASE_URL must be an origin without a path (e.g. https://api.telgea.com).');
  }

  if (parsed.protocol === 'https:') {
    return;
  }

  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) {
    return;
  }

  throw new Error(
    `Refusing to send the Telgea API key over ${parsed.protocol}//. Use https:// (loopback http:// is allowed for local mocks).`,
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}
