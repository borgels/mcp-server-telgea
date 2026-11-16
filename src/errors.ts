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
