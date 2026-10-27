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
    this.url = redactSecrets(input.url);
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
  return SECRET_PATTERNS.reduce(
    (current, pattern) =>
      current.replace(pattern, match => {
        const separator = match.includes(':') ? ':' : '=';
        const key = match.split(separator)[0]?.trim() ?? 'secret';
        return `${key}${separator} [REDACTED]`;
      }),
    value,
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
    problem?.code ? `code=${problem.code}` : undefined,
    problem?.title,
    problem?.detail,
    problem?.fields === undefined ? undefined : `fields=${JSON.stringify(problem.fields)}`,
    problem?.requestId ? `requestId=${problem.requestId}` : undefined,
    retryAfter ? `retry-after=${retryAfter}s` : undefined,
    !problem && typeof payload === 'string' && payload ? payload.slice(0, 500) : undefined,
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

function isProblem(value: unknown): value is TelgeaProblem {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
