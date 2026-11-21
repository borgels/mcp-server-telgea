/** RFC 9457 Problem Details, as every Telgea error body is shaped. */
export interface TelgeaProblem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  code?: string;
  requestId?: string;
  fields?: unknown;
  [extension: string]: unknown;
}

/** Maximum length of any single piece of text taken from a response body. */
export const MAX_ERROR_TEXT = 500;
/** Configured secrets shorter than this are not redacted by value (too likely to hit normal text). */
const MIN_SECRET_LENGTH = 8;

const registeredSecrets = new Set<string>();

/** Redact this exact value (and its URL-encoded form) wherever it appears in error text. */
export function registerSecret(value: string | undefined): void {
  if (!value || value.length < MIN_SECRET_LENGTH) {
    return;
  }
  registeredSecrets.add(value);
  const encoded = encodeURIComponent(value);
  if (encoded !== value) {
    registeredSecrets.add(encoded);
  }
}

/** Origin and path of a URL, without query string or fragment. */
export function describeUrl(url: string | URL): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

/** Truncate after redaction, so a secret cut in half is never left behind. */
export function truncate(value: string, max: number = MAX_ERROR_TEXT): string {
  return value.length > max ? `${value.slice(0, max)}… [truncated, ${value.length} chars]` : value;
}

function textPart(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  return truncate(redactSecrets(value.trim()));
}

const SECRET_PATTERNS = [
  /x-api-key:\s*[^,\s}]+/gi,
  /(apiKey|TELGEA_API_KEY|api_key|x-api-key)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

export class TelgeaHttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly code?: string;
  readonly requestId?: string;
  readonly problem?: TelgeaProblem;
  readonly retryAfter?: string;

  constructor(input: {
    status: number;
    url: string;
    payload?: unknown;
    retryAfter?: string;
  }) {
    const problem = isProblem(input.payload) ? input.payload : undefined;
    super(formatTelgeaHttpError(input.status, problem, input.payload, input.retryAfter));
    this.name = 'TelgeaHttpError';
    this.status = input.status;
    this.url = redactSecrets(describeUrl(input.url));
    this.problem = problem;
    this.code = typeof problem?.code === 'string' ? problem.code : undefined;
    this.requestId = typeof problem?.requestId === 'string' ? problem.requestId : undefined;
    this.retryAfter = input.retryAfter;
  }
}

/**
 * An answer from Telgea that failed, as the embedded gateway's client throws it: an HTTP error or a redirect, which is
 * never followed. Our own text, the status and Telgea's request id from a response header (only in the form such ids
 * have); nothing of the body or the Location.
 */
export class TelgeaAnswerError extends Error {
  readonly status: number;
  /** Telgea's id for the request, when a response header gives one as a UUID or hex id (never in the message). */
  readonly requestId?: string;

  constructor(message: string, status: number, requestId?: string) {
    super(message);
    this.name = 'TelgeaAnswerError';
    this.status = status;
    this.requestId = vendorRequestId(requestId);
  }
}

/**
 * Response headers that carry the vendor's own id for a request, most specific first.
 */
export const REQUEST_ID_HEADERS: readonly string[] = [
  'x-request-id',
  'request-id',
  'x-correlation-id',
  'correlation-id',
  'x-ms-request-id',
  'x-amzn-requestid',
];

/**
 * A hex id: one run of hex digits, or groups of at least four hex digits joined by single hyphens (a UUID is one),
 * 8 to 64 characters in all. A name, a sentence or an e-mail address never fits.
 */
const REQUEST_ID_FORM = /^[0-9A-Fa-f]{4,}(?:-[0-9A-Fa-f]{4,})*$/;
/** Six digits and four more: the shape of a Danish personal number. An id that holds it is dropped. */
const PERSONAL_NUMBER_SHAPE = /\d{6}-?\d{4}/;

/**
 * The vendor's request id, only in the form such ids have (a UUID or a hex id of 8 to 64 characters), or
 * undefined. Anything else, and an id that holds the shape of a personal number, is dropped: the value comes from
 * the vendor and is kept only when it cannot be text.
 */
export function vendorRequestId(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id.length >= 8 && id.length <= 64 && REQUEST_ID_FORM.test(id) && !PERSONAL_NUMBER_SHAPE.test(id) ? id : undefined;
}

/** The vendor's request id from the first of REQUEST_ID_HEADERS a response has in the right form, or undefined. */
export function requestIdFrom(headers: Headers, names: readonly string[] = REQUEST_ID_HEADERS): string | undefined {
  for (const name of names) {
    const id = vendorRequestId(headers.get(name));
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * Metadata about a failed call, for a host that counts failures: the HTTP status Telgea answered with and its
 * request id. Never the response body, Telgea's error code or message, or the input.
 */
export interface FailureMetadata {
  /** The HTTP status of Telgea's answer (100-599). */
  httpStatus: number;
  /** Telgea's own id for the request, as a UUID or hex id only. */
  requestId?: string;
}

/**
 * The failure metadata of an error: an answer from Telgea that failed (an HTTP error or a refused redirect, see
 * TelgeaAnswerError) gives its status and request id.
 */
export function failureMetadata(error: unknown): FailureMetadata | undefined {
  if (!(error instanceof TelgeaAnswerError)) return undefined;
  const status = error.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) return undefined;
  const requestId = vendorRequestId(error.requestId);
  return requestId === undefined ? { httpStatus: status } : { httpStatus: status, requestId };
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

export function redactSecrets(value: string): string {
  let result = value;
  for (const secret of registeredSecrets) {
    result = result.split(secret).join('[REDACTED]');
  }
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    result,
  );
}

function formatTelgeaHttpError(
  status: number,
  problem: TelgeaProblem | undefined,
  payload: unknown,
  retryAfter: string | undefined,
): string {
  const parts = [
    `Telgea API request failed with HTTP ${status}`,
    problem?.code ? `code=${truncate(redactSecrets(String(problem.code)), 64)}` : undefined,
    textPart(problem?.title),
    textPart(problem?.detail),
    problem?.fields === undefined ? undefined : `fields=${textPart(JSON.stringify(problem.fields) ?? '')}`,
    problem?.requestId ? `requestId=${truncate(redactSecrets(String(problem.requestId)), 128)}` : undefined,
    retryAfter ? `retry-after=${truncate(retryAfter, 64)}s` : undefined,
    !problem && typeof payload === 'string' ? textPart(payload) : undefined,
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

function isProblem(value: unknown): value is TelgeaProblem {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
