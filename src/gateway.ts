import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { fixedOutputs, withheldResult } from './fallbacks.js';
import { admitsKey, KEY_REFUSED, leaksSecret, maskedText, sealedError } from './key-admission.js';
import { redactDeep, redactText } from './redaction.js';
import { writeGatewayAuditEvent } from './telgea/gateway-audit.js';
import { TelgeaGatewayClient } from './telgea/gateway-client.js';
import { GATEWAY_TOOLS, type GatewayTool } from './telgea/gateway-tools.js';
import {
  canonicalToolName,
  currentInstancePolicy,
  GatewayConfigError,
  resolveInstancePolicy,
  runInCallScope,
  TOOL_PREFIX,
  type CallContext,
  type InstancePolicy,
  type ResolvedInstancePolicy,
} from './telgea/scope.js';
import { SecretRedactor } from './upstream-http.js';

/**
 * Embeddable entry point (package export `./gateway`): an embedding host,
 * such as an MCP gateway that does its own per-user authorization, lists
 * `tools` and invokes `callTool`. The tools, their inputs and their answer
 * allowlists live in src/telgea/gateway-tools.ts.
 *
 * Several gateway instances (for example one per tenant) can run in one
 * process. Each instance uses only the API key passed to
 * createTelgeaGateway and reads no TELGEA_* variable at all: not the key
 * (TELGEA_API_KEY), not the address (TELGEA_BASE_URL: the gateway talks to
 * https://api.telgea.com only), not TELGEA_TIMEOUT_MS (30 seconds unless
 * `timeoutMs` is given), not TELGEA_ENABLE_WRITES or the other tier switches
 * (the host's policy decides), not the cache or the request budget, and not
 * TELGEA_AUDIT_LOG. Redirects are never followed.
 *
 * Instance policy (writes, disabled tools, audit) comes from the host when it
 * passes `policy`; without it the instance uses the default policy (no
 * writes, no disabled tools, no audit records).
 *
 * Every call runs in a call scope of its own (AsyncLocalStorage), so a call
 * made from inside another instance's call (from its audit sink or its fetch)
 * never inherits that instance's policy, sink, redactor or caller.
 */

export type { AuditSink, InstancePolicy } from './telgea/scope.js';
export { GatewayConfigError } from './telgea/scope.js';
export { KEY_REFUSED } from './key-admission.js';
export { TELGEA_API_ORIGIN } from './telgea/gateway-client.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue =
  | string
  | number
  | boolean
  | null
  | GatewayJsonValue[]
  | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
}

/** Who and which request a call belongs to; written to the audit records of the call. */
export type GatewayCallContext = CallContext;

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

/** One Telgea API request a tool may make: the method and the path template on https://api.telgea.com. */
export interface GatewayUpstreamOperation {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
}

/** A tool catalog entry: the gateway definition plus the upstream requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  /** Every Telgea request the tool may make. Empty for a tool that does not call Telgea. */
  readonly upstream: readonly GatewayUpstreamOperation[];
  /**
   * True when the tool can read more than its name says (anything in the
   * system, chosen by the input). No Telgea gateway tool is broad.
   */
  readonly broad: boolean;
}

export interface TelgeaGatewayOptions {
  /** The organisation's Telgea API key, sent as `x-api-key`. Required; never read from the environment. */
  apiKey: string;
  /** The fetch to use (tests, or a host's own). Redirects are never followed either way. */
  fetchImpl?: typeof fetch;
  /** Time limit per Telgea request in milliseconds. Default 30 seconds; never read from the environment. */
  timeoutMs?: number;
  /**
   * Instance policy from the host. Without it the instance uses the default
   * policy (no writes, no disabled tools, no audit records); it never reads
   * a policy or audit variable from the environment.
   */
  policy?: InstancePolicy;
}

/**
 * JSON Schema for a gateway tool, derived from the same zod schema the call
 * is validated with. `format` and `pattern` are dropped: validators such as
 * Ajv reject unknown formats in strict mode, and zod checks the values when
 * the call runs.
 */
function toJsonSchema(schema: z.ZodType): GatewayJsonObject {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    io: 'input',
    override: ctx => {
      delete (ctx.jsonSchema as Record<string, unknown>).format;
      delete (ctx.jsonSchema as Record<string, unknown>).pattern;
    },
  }) as Record<string, unknown>;
  return json as GatewayJsonObject;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

/** Strict input schemas: an unknown field is refused, not dropped. */
const SCHEMAS: ReadonlyMap<string, z.ZodType> = new Map(
  GATEWAY_TOOLS.map(tool => [`${TOOL_PREFIX}${tool.name}`, z.strictObject(tool.input)]),
);
const BY_NAME: ReadonlyMap<string, GatewayTool> = new Map(GATEWAY_TOOLS.map(tool => [`${TOOL_PREFIX}${tool.name}`, tool]));
const GATEWAY_TOOL_NAMES: readonly string[] = [...BY_NAME.keys()];

function definition(tool: GatewayTool): GatewayToolDefinition {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    riskLevel: tool.riskLevel,
    enabledByDefault: tool.riskLevel === 'read',
    inputSchema: toJsonSchema(SCHEMAS.get(`${TOOL_PREFIX}${tool.name}`)!),
  };
}

/** All gateway tools, as definitions (names without the prefix). */
export const telgeaGatewayTools: GatewayToolDefinition[] = GATEWAY_TOOLS.map(definition);

/**
 * The tool catalog: every gateway tool with its definition, the upstream
 * requests it may make and the broad mark. Generated from the same table as
 * `telgeaGatewayTools` and deeply frozen. Hosts can use it to build their own
 * permission model without creating a gateway instance.
 */
export const telgeaToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  GATEWAY_TOOLS.map(tool => ({
    ...definition(tool),
    upstream: tool.upstream.map(operation => ({ ...operation })),
    broad: tool.broad === true,
  })),
);

/** KEY_REFUSED with every run that shares a piece with any of the secrets masked, so it holds no piece of one. */
function refusedText(field: string, secrets: readonly unknown[]): string {
  return secrets.reduce<string>((text, secret) => maskedText(text, secret), `${field}: ${KEY_REFUSED}`);
}

function requiredKey(options: TelgeaGatewayOptions | undefined, given: readonly unknown[]): string {
  const apiKey: unknown = options?.apiKey;
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new GatewayConfigError(
      'createTelgeaGateway requires options.apiKey. Embedded instances do not read credentials from the environment.',
    );
  }
  // Key admission (src/key-admission.ts): printable ASCII of 16 characters or more, sharing no piece with any text of
  // ours. Checked before anything is built from it; the refusal is a fixed text that holds no piece of it.
  if (!admitsKey(apiKey.trim())) throw new GatewayConfigError(refusedText('options.apiKey', given));
  return apiKey.trim();
}

/** A caller id from the host: redacted before it is cut short, so no part of a secret survives. */
function contextValue(value: unknown, redactor: SecretRedactor): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? redactor.redact(value.trim()).slice(0, 200) : undefined;
}

/**
 * Create one gateway instance. `apiKey` is required and is the only
 * credential the instance uses; a missing or refused key fails here, before
 * anything is built or sent.
 */
export function createTelgeaGateway(options: TelgeaGatewayOptions) {
  let key: string | undefined;
  let guard: SecretRedactor | undefined;
  // What the host gave, admitted or not: every error is masked against it.
  const raw = options as Partial<TelgeaGatewayOptions> | undefined;
  const secrets = typeof raw?.apiKey === 'string' ? [raw.apiKey, raw.apiKey.trim()] : [];
  try {
    key = requiredKey(options, secrets);
    guard = new SecretRedactor().addSecret(key);
    // The fixed outputs of the sink check (src/fallbacks.ts) must hold no piece of the key.
    if (leaksSecret(fixedOutputs(), guard)) {
      throw new GatewayConfigError(refusedText('options', secrets));
    }
    const gateway = buildTelgeaGateway(options, key, guard);
    // The tool list leaves the gateway as it is: a key that shares a piece with it is refused.
    if (leaksSecret(gateway.tools, guard)) {
      throw new GatewayConfigError(refusedText('options', secrets));
    }
    return gateway;
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (guard && key !== undefined) {
      message = guard.redact(message);
      if (leaksSecret(message, guard)) message = refusedText('options', secrets);
    }
    // A fresh error in final form (src/key-admission.ts, sealedError), then the sink check on the finished object.
    const final = sealedError(new GatewayConfigError(message), ...secrets);
    if (guard && key !== undefined && leaksSecret(final, guard)) {
      throw sealedError(new GatewayConfigError(refusedText('options', secrets)), ...secrets);
    }
    throw final;
  }
}

function buildTelgeaGateway(options: TelgeaGatewayOptions, apiKey: string, redactor: SecretRedactor) {
  // Only these options are read; anything else a host passes (a base URL, a budget, ...) is dropped.
  const { policy: hostPolicy, fetchImpl, timeoutMs } = options;
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') {
    throw new GatewayConfigError('options.fetchImpl must be a function.');
  }
  // Always a policy: the host's, or the default one. A gateway call never reads policy or audit variables.
  const policy: ResolvedInstancePolicy = resolveInstancePolicy(hostPolicy ?? {}, GATEWAY_TOOL_NAMES);
  let client: TelgeaGatewayClient;
  try {
    client = new TelgeaGatewayClient({ apiKey, redactor, ...(fetchImpl ? { fetchImpl } : {}), timeoutMs });
  } catch (error) {
    throw new GatewayConfigError(error instanceof Error ? error.message : 'Invalid options.');
  }
  const offeredNames: ReadonlySet<string> = new Set(GATEWAY_TOOL_NAMES.filter(name => !policy.disabledTools.has(name)));
  const offered: readonly GatewayTool[] = GATEWAY_TOOLS.filter(tool => offeredNames.has(`${TOOL_PREFIX}${tool.name}`));

  return {
    /** Tools enabled on this instance (tools the host's policy disables are left out). */
    tools: telgeaGatewayTools.filter(tool => !policy.disabledTools.has(canonicalToolName(tool.name))),
    callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      return runInCallScope(
        {
          policy,
          redactor,
          caller: contextValue(context?.caller, redactor),
          // Our own id for the call: the host's request id is its text, and is not written to the audit.
          requestId: randomUUID(),
          offeredTools: offeredNames,
        },
        () =>
          runCall(toolName, input).then(result => {
            const final = result.isError ? (redactDeep(result, redactor) as GatewayToolResult) : result;
            // The sink check, as the very last step: a result that holds a piece of the key anywhere is withheld whole.
            return leaksSecret(final, redactor) ? withheldResult() : final;
          }),
      );
    },
  };

  async function runCall(toolName: string, input: GatewayJsonObject): Promise<GatewayToolResult> {
    try {
      const name = typeof toolName === 'string' ? canonicalToolName(toolName) : '';
      const tool = BY_NAME.get(name);
      const schema = SCHEMAS.get(name);
      if (!tool || !schema) {
        // Neither the audit record nor the answer repeats the name: it is the caller's text, not ours.
        await writeGatewayAuditEvent({ tool: UNKNOWN_TOOL, action: 'rejected', reason: 'unsupported tool' });
        return errorResult('Unsupported Telgea gateway tool.');
      }

      const parsed = schema.safeParse(input ?? {});
      if (!parsed.success) {
        await writeGatewayAuditEvent({ tool: name, action: 'rejected', reason: 'invalid input' });
        return errorResult(redactText(`Invalid input for ${tool.name}: ${z.prettifyError(parsed.error)}`, redactor));
      }
      const values = parsed.data as Record<string, unknown>;

      const denied = policyDenial(name, tool);
      const target = auditTarget(values);
      if (denied) {
        await writeGatewayAuditEvent({ tool: name, action: 'policy_denied', target, reason: denied });
        return errorResult(denied);
      }
      await writeGatewayAuditEvent({ tool: name, action: 'start', target });
      let data: unknown;
      try {
        data = await tool.run(tool.riskLevel === 'read' ? readOnly(client, tool.name) : client, values, offered);
      } catch (error) {
        await writeGatewayAuditEvent({ tool: name, action: 'error', target, status: 'error', error });
        throw error;
      }
      await writeGatewayAuditEvent({ tool: name, action: 'finish', target, status: 'ok' });
      // Twice: the second pass, the last step, also covers what the first inserted (the depth placeholder).
      return jsonResult(tool.summary, redactDeep(redactDeep(data, redactor), redactor));
    } catch (error) {
      return errorResult(redactText(error instanceof Error ? error.message : String(error), redactor));
    }
  }
}

/** Why the host's policy refuses a tool, or undefined when it may run. */
function policyDenial(name: string, tool: GatewayTool): string | undefined {
  const policy = currentInstancePolicy()!;
  if (policy.disabledTools.has(name)) return 'This tool is disabled on this instance by the embedding host.';
  if (tool.riskLevel !== 'read' && !policy.enableWrites) {
    return 'Writes are disabled. The embedding host has not enabled writes for this instance.';
  }
  return undefined;
}

/** A view of the client that can only read: a read tool that tries to change something is refused. */
function readOnly(client: TelgeaGatewayClient, tool: string): TelgeaGatewayClient {
  const refuse = async () => {
    throw new Error(`Read tool ${tool} attempted a change in Telgea; refused.`);
  };
  return Object.assign(Object.create(client) as TelgeaGatewayClient, { send: refuse });
}

/** The ids a call is about (hashed in the audit record). */
function auditTarget(input: Record<string, unknown>): unknown {
  return {
    userId: input.userId,
    numberId: input.numberId,
    teamId: input.teamId,
    poolId: input.poolId,
    action: input.action,
    usageType: input.usageType,
  };
}

/** The audit's tool for a call to a tool this gateway does not have. */
const UNKNOWN_TOOL = 'unknown_tool';

/** One gateway instance, as returned by createTelgeaGateway. */
export type TelgeaGateway = ReturnType<typeof createTelgeaGateway>;

/**
 * The summary, then the same (already redacted) data as compact JSON in the text block, as the MCP spec asks of a
 * tool that returns structured content: many clients read only the text. The text holds exactly
 * `structuredContent`, and the sink check in callTool covers it.
 */
function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  const data = JSON.parse(JSON.stringify(structuredContent ?? null)) as GatewayJsonValue;
  return {
    content: [{ type: 'text', text: `${text}\n\n${JSON.stringify(data)}` }],
    structuredContent: data,
  };
}

function errorResult(text: string): GatewayToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}
