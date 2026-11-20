import { z } from 'zod/v4';
import type { GatewayQueryValue, TelgeaGatewayClient } from './gateway-client.js';

/**
 * The tools of the embedded gateway (src/gateway.ts): narrow inputs, and
 * every answer projected onto an allowlist of fields before it leaves. A
 * field that is not named here is never passed on, so the SIM of a line
 * (ICCID, eSIM activation code, PIN and PUK), previous SIMs, and anything
 * Telgea adds later never reach the host.
 *
 * Left out on purpose: SIM credentials, number port-ins, raw usage records
 * (who was called or texted, when), live network data of a line (IMEI,
 * serving network), ordering or terminating plans and lines, SIM swaps,
 * creating or changing users and teams, and removing a cost threshold. No
 * tool deletes anything. The three changes (a cost threshold, a data
 * restriction and a line suspension) can each be undone with the same tool.
 *
 * The MCP server's own tools (src/tools/telgea.ts) are unchanged.
 */

export type GatewayUpstreamMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface GatewayUpstream {
  readonly method: GatewayUpstreamMethod;
  readonly path: string;
}

export interface GatewayTool {
  /** Without the `telgea_` prefix. */
  name: string;
  title: string;
  description: string;
  riskLevel: 'read' | 'write';
  /** The first line of a successful result's text. */
  summary: string;
  upstream: readonly GatewayUpstream[];
  broad?: boolean;
  input: z.ZodRawShape;
  run(client: TelgeaGatewayClient, input: Record<string, unknown>, offered: readonly GatewayTool[]): Promise<unknown>;
}

const get = (path: string): GatewayUpstream => ({ method: 'GET', path });

// ---------------------------------------------------------------- inputs

const uuid = z.guid();
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD');
const country = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'a country code such as DK')
  .transform(value => value.toUpperCase());
const msisdn = z
  .string()
  .trim()
  .regex(/^\+\d{6,15}$/, 'a phone number in E.164 form, e.g. +4512345678');
const usageType = z.enum(['DATA', 'VOICE', 'SMS', 'MMS']).describe('VOICE means international calling.');
const lineState = z.enum([
  'PENDING',
  'PORTING',
  'PORTING_FAILED',
  'PROVISIONING',
  'READY',
  'REPLACING',
  'CHANGING',
  'SUSPENDING',
  'SUSPENDED',
  'RESTORING',
  'RECONFIGURING',
  'DEACTIVATING',
  'DEACTIVATED',
  'PORTING_DISCARDED',
  'PORTING_OUT',
  'PORTED_OUT',
]);
const page = (max: number) => ({
  page: z.number().int().min(1).max(10_000).optional().describe('Page to return, starting at 1.'),
  pageSize: z.number().int().min(1).max(max).optional().describe(`Items per page, at most ${max}.`),
});

// ----------------------------------------------------------- projections

type Json = Record<string, unknown>;
type Projection = Record<string, (value: unknown) => unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

/** A string, number, boolean or null as it is; anything else is dropped. */
function plain(value: unknown): unknown {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined;
}

/** An object of numbers only (a usage bucket keyed by region or by local/international). */
function numbers(value: unknown): unknown {
  const object = asObject(value);
  if (!object) return undefined;
  return Object.fromEntries(Object.entries(object).filter(([, entry]) => typeof entry === 'number'));
}

/** Only the named fields of `source`, each through its projection; fields that come out undefined are left out. */
function pick(source: unknown, projection: Projection): Json {
  const object = asObject(source) ?? {};
  const out: Json = {};
  for (const [field, project] of Object.entries(projection)) {
    if (!Object.hasOwn(object, field)) continue;
    const value = project(object[field]);
    if (value !== undefined) out[field] = value;
  }
  return out;
}

const listOf =
  (projection: Projection) =>
  (value: unknown): unknown =>
    Array.isArray(value) ? value.map(entry => pick(entry, projection)) : undefined;

const objectOf =
  (projection: Projection) =>
  (value: unknown): unknown =>
    value === null ? null : asObject(value) ? pick(value, projection) : undefined;

/** A page of a numbered list. */
function paged(projection: Projection): Projection {
  return { page: plain, pageSize: plain, itemsCount: plain, items: listOf(projection) };
}

const USER: Projection = {
  id: plain,
  email: plain,
  firstName: plain,
  lastName: plain,
  teamId: plain,
  employeeId: plain,
  costCode: plain,
};
const TEAM: Projection = { id: plain, name: plain, emoji: plain, costCode: plain, memberCount: plain, isDefault: plain };
const PLAN_ROW: Projection = {
  id: plain,
  userId: plain,
  firstName: plain,
  lastName: plain,
  email: plain,
  status: plain,
  localPhoneNumber: plain,
  localNumberCount: plain,
  teamId: plain,
  teamName: plain,
};
/** A line as a plan holds it: never its SIM. */
const PLAN_LINE: Projection = { id: plain, type: plain, countryCode: plain, phoneNumber: plain, state: plain };
const PLAN: Projection = {
  userId: plain,
  email: plain,
  firstName: plain,
  lastName: plain,
  status: plain,
  teamId: plain,
  terminationScheduledAt: plain,
  localNumberCount: plain,
  localNumber: objectOf(PLAN_LINE),
  localNumbers: listOf(PLAN_LINE),
  travelNumber: objectOf(PLAN_LINE),
};
const LINE_ROW: Projection = {
  id: plain,
  type: plain,
  countryCode: plain,
  phoneNumber: plain,
  state: plain,
  userId: plain,
  createdAt: plain,
};
const LINE: Projection = {
  ...LINE_ROW,
  stateUpdatedAt: plain,
  activatedAt: plain,
  terminationScheduledAt: plain,
};
const BUCKET: Projection = { interval: plain, usage: numbers };
const STATS: Projection = { highest: plain, lowest: plain, average: plain };
const ANALYTICS: Projection = {
  usage: objectOf({ data: listOf(BUCKET), voice: listOf(BUCKET), sms: listOf(BUCKET) }),
  metadata: objectOf({ data: objectOf(STATS), voice: objectOf(STATS), sms: objectOf(STATS) }),
};
const POOL: Projection = {
  poolId: plain,
  regionId: plain,
  regionName: plain,
  totalAmountGB: plain,
  consumedGB: plain,
  remainingGB: plain,
  expirationDate: plain,
  hasActiveRestrictions: plain,
};
const POOL_MEMBER: Projection = {
  userId: plain,
  msisdn: plain,
  numberType: plain,
  firstName: plain,
  lastName: plain,
  activationDate: plain,
  terminationDate: plain,
  usageBytes: plain,
};
const RATE: Projection = { country: plain, ratePerUnit: plain, unit: plain, currency: plain, validFrom: plain };
const THRESHOLD: Projection = {
  id: plain,
  usageType: plain,
  scope: plain,
  teamId: plain,
  userId: plain,
  maxAmount: plain,
  currency: plain,
  period: plain,
  validFrom: plain,
  validTo: plain,
};

// --------------------------------------------------------------- helpers

/** A path segment from a validated uuid or enum: encoded, and nothing that could change the path. */
function segment(value: unknown): string {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(text)) throw new Error('Invalid id.');
  return encodeURIComponent(text);
}

function query(input: Record<string, unknown>, fields: readonly string[]): Record<string, GatewayQueryValue> {
  const out: Record<string, GatewayQueryValue> = {};
  for (const field of fields) {
    const value = input[field];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[field] = value;
  }
  return out;
}

function assertWindow(startDate: string, endDate: string): void {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new Error('startDate and endDate must be valid dates.');
  if (end < start) throw new Error('endDate is before startDate.');
  if ((end - start) / 86_400_000 + 1 > 366) throw new Error('The window may span at most 366 days.');
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(word => word.length >= 2);
}

// ----------------------------------------------------------------- tools

export const GATEWAY_TOOLS: readonly GatewayTool[] = [
  {
    name: 'search_capabilities',
    title: 'Search Telgea capabilities',
    description: 'Find the Telgea tools this connection offers. Does not call Telgea.',
    riskLevel: 'read',
    summary: 'Telgea capabilities.',
    upstream: [],
    input: {
      query: z.string().trim().max(500).default(''),
      limit: z.number().int().min(1).max(50).default(20),
    },
    async run(_client, input, offered) {
      const asked = words(String(input.query ?? ''));
      const scored = offered.map((tool, order) => {
        const own = words(`${tool.name} ${tool.title} ${tool.description}`);
        const score = asked.filter(word => own.some(o => o === word || (o.length >= 4 && word.startsWith(o)))).length;
        return { tool, order, score };
      });
      const hits = asked.length === 0 ? scored : scored.filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);
      return {
        query: input.query,
        tools: hits.slice(0, Number(input.limit)).map(({ tool }) => ({
          name: `telgea_${tool.name}`,
          title: tool.title,
          description: tool.description,
          riskLevel: tool.riskLevel,
        })),
      };
    },
  },
  {
    name: 'check_connection',
    title: 'Check Telgea connection',
    description: 'Verify that Telgea accepts the API key, and show how many teams the organisation has.',
    riskLevel: 'read',
    summary: 'Telgea connection checked.',
    upstream: [get('/v1/teams')],
    input: {},
    async run(client) {
      const teams = asObject(await client.get('/v1/teams', { page: 1, pageSize: 1 }));
      return { connected: true, teamCount: plain(teams?.itemsCount) ?? null };
    },
  },
  {
    name: 'list_users',
    title: 'List Telgea users',
    description:
      'List the organisation’s users (employees): name, email, team, employee id and cost code. Filter by exact email or employee id.',
    riskLevel: 'read',
    summary: 'Telgea users.',
    upstream: [get('/v1/users')],
    input: {
      email: z.email().optional().describe('Exact email.'),
      employeeId: z.string().trim().min(1).max(100).optional().describe('Exact employee id.'),
      ...page(50),
    },
    async run(client, input) {
      return pick(await client.get('/v1/users', query(input, ['email', 'employeeId', 'page', 'pageSize'])), paged(USER));
    },
  },
  {
    name: 'list_teams',
    title: 'List Telgea teams',
    description: 'List teams with member counts and cost codes.',
    riskLevel: 'read',
    summary: 'Telgea teams.',
    upstream: [get('/v1/teams')],
    input: { ...page(50) },
    async run(client, input) {
      return pick(await client.get('/v1/teams', query(input, ['page', 'pageSize'])), paged(TEAM));
    },
  },
  {
    name: 'list_user_plans',
    title: 'List Telgea subscriptions',
    description: 'List subscriptions (user plans): the person, status (ACTIVE, PROVISIONING, PORTING, TERMINATING, ...), local number and team.',
    riskLevel: 'read',
    summary: 'Telgea subscriptions.',
    upstream: [get('/v1/user-plans')],
    input: {
      orderBy: z.enum(['firstName', 'localPhoneNumber', 'status', 'teamName']).optional(),
      orderDirection: z.enum(['asc', 'desc']).optional(),
      ...page(50),
    },
    async run(client, input) {
      return pick(
        await client.get('/v1/user-plans', query(input, ['orderBy', 'orderDirection', 'page', 'pageSize'])),
        paged(PLAN_ROW),
      );
    },
  },
  {
    name: 'get_user_plan',
    title: 'Get Telgea subscription',
    description:
      'One person’s subscription, by userId, or found by email or phone number (exactly one): status, team, scheduled termination and the lines (number, type and state). SIM data is never returned.',
    riskLevel: 'read',
    summary: 'Telgea subscription.',
    upstream: [get('/v1/user-plans/{userId}'), get('/v1/user-plans/search')],
    input: { userId: uuid.optional(), email: z.email().optional(), msisdn: msisdn.optional() },
    async run(client, input) {
      const given = [input.userId, input.email, input.msisdn].filter(value => value !== undefined).length;
      if (given !== 1) throw new Error('Give exactly one of userId, email or msisdn.');
      const plan =
        input.userId !== undefined
          ? await client.get(`/v1/user-plans/${segment(input.userId)}`)
          : await client.get('/v1/user-plans/search', query(input, ['email', 'msisdn']));
      return pick(plan, PLAN);
    },
  },
  {
    name: 'list_lines',
    title: 'List Telgea lines',
    description: 'List lines (phone numbers): type local or travel, state and holder. Filter by number, user, type or state. SIM data is never returned.',
    riskLevel: 'read',
    summary: 'Telgea lines.',
    upstream: [get('/v1/numbers')],
    input: {
      msisdn: msisdn.optional(),
      userId: uuid.optional().describe('Only this user’s lines.'),
      type: z.enum(['local', 'travel']).optional(),
      state: lineState.optional(),
      orderBy: z.enum(['createdAt', 'phoneNumber', 'type']).optional(),
      orderDirection: z.enum(['asc', 'desc']).optional(),
      ...page(100),
    },
    async run(client, input) {
      return pick(
        await client.get(
          '/v1/numbers',
          query(input, ['msisdn', 'userId', 'type', 'state', 'orderBy', 'orderDirection', 'page', 'pageSize']),
        ),
        paged(LINE_ROW),
      );
    },
  },
  {
    name: 'get_line',
    title: 'Get Telgea line',
    description: 'One line: number, type, state, holder and when it was activated or is scheduled to end. SIM data is never returned.',
    riskLevel: 'read',
    summary: 'Telgea line.',
    upstream: [get('/v1/numbers/{numberId}')],
    input: { numberId: uuid },
    async run(client, input) {
      return pick(await client.get(`/v1/numbers/${segment(input.numberId)}`), LINE);
    },
  },
  {
    name: 'get_usage_analytics',
    title: 'Get Telgea usage',
    description:
      'Usage summed per day or month: data in bytes per region, calls in seconds and SMS as a count, local and international, with highest, lowest and average. For the organisation, one user or one number. Never single calls or messages.',
    riskLevel: 'read',
    summary: 'Telgea usage.',
    upstream: [get('/v1/analytics')],
    input: {
      startDate: isoDate,
      endDate: isoDate,
      interval: z.enum(['month', 'day']),
      userId: uuid.optional(),
      msisdn: msisdn.optional(),
      countryIsoCode: country.optional().describe('Only usage served in this country.'),
      orderBy: z.enum(['asc', 'desc']).optional(),
    },
    async run(client, input) {
      assertWindow(String(input.startDate), String(input.endDate));
      return pick(
        await client.get(
          '/v1/analytics',
          query(input, ['startDate', 'endDate', 'interval', 'userId', 'msisdn', 'countryIsoCode', 'orderBy']),
        ),
        ANALYTICS,
      );
    },
  },
  {
    name: 'list_data_pools',
    title: 'List Telgea data pools',
    description: 'Shared data pools: region, total, used and remaining GB, expiry, and whether restrictions are active.',
    riskLevel: 'read',
    summary: 'Telgea data pools.',
    upstream: [get('/v1/data-pools')],
    input: {},
    async run(client) {
      return pick(await client.get('/v1/data-pools'), { pools: listOf(POOL) });
    },
  },
  {
    name: 'list_data_pool_members',
    title: 'List Telgea data pool members',
    description: 'The members of one data pool, with each one’s number and data use.',
    riskLevel: 'read',
    summary: 'Telgea data pool members.',
    upstream: [get('/v1/data-pools/{poolId}/members')],
    input: { poolId: uuid },
    async run(client, input) {
      return pick(await client.get(`/v1/data-pools/${segment(input.poolId)}/members`), {
        poolId: plain,
        members: listOf(POOL_MEMBER),
      });
    },
  },
  {
    name: 'list_rates',
    title: 'List Telgea rates',
    description: 'Pay-as-you-go prices for a home market: international calls, SMS or MMS, or roaming data, per country.',
    riskLevel: 'read',
    summary: 'Telgea rates.',
    upstream: [get('/v1/rates')],
    input: {
      market: country.describe('Home market, e.g. DK.'),
      type: z.enum(['INTL_VOICE', 'INTL_SMS', 'INTL_MMS', 'ROAMING_DATA']),
      servingCountry: country.optional().describe('Where the person is, when roaming.'),
      direction: z.enum(['outbound', 'inbound']).optional(),
      asOfDate: isoDate.optional(),
      ...page(250),
    },
    async run(client, input) {
      return pick(
        await client.get(
          '/v1/rates',
          query(input, ['market', 'type', 'servingCountry', 'direction', 'asOfDate', 'page', 'pageSize']),
        ),
        {
          page: plain,
          pageSize: plain,
          itemsCount: plain,
          market: plain,
          servingCountry: plain,
          direction: plain,
          asOfDate: plain,
          items: listOf(RATE),
        },
      );
    },
  },
  {
    name: 'list_cost_thresholds',
    title: 'List Telgea cost thresholds',
    description: 'Monthly spending caps for the organisation, a team (teamId) or a user (userId).',
    riskLevel: 'read',
    summary: 'Telgea cost thresholds.',
    upstream: [get('/v1/cost-thresholds')],
    input: { usageType: usageType.optional(), teamId: uuid.optional(), userId: uuid.optional() },
    async run(client, input) {
      if (input.teamId !== undefined && input.userId !== undefined) throw new Error('Give teamId or userId, not both.');
      return pick(await client.get('/v1/cost-thresholds', query(input, ['usageType', 'teamId', 'userId'])), {
        thresholds: listOf(THRESHOLD),
        currency: plain,
      });
    },
  },
  {
    name: 'get_user_cost_threshold',
    title: 'Get Telgea cost threshold of a user',
    description: 'The cap that applies to one user for one kind of usage, what the user has spent this period, and whether usage is paused.',
    riskLevel: 'read',
    summary: 'Telgea cost threshold of a user.',
    upstream: [get('/v1/users/{userId}/cost-thresholds/{usageType}')],
    input: { userId: uuid, usageType },
    async run(client, input) {
      return pick(await client.get(`/v1/users/${segment(input.userId)}/cost-thresholds/${segment(input.usageType)}`), {
        threshold: objectOf(THRESHOLD),
        spend: objectOf({ amount: plain, currency: plain, periodStart: plain }),
        pausedUntil: plain,
      });
    },
  },
  {
    name: 'set_cost_threshold',
    title: 'Set Telgea cost threshold',
    description:
      'Set a monthly spending cap for the organisation, a team (teamId) or a user (userId); reaching it pauses that usage. Telgea currently enforces VOICE (international calls). Set it again to change it.',
    riskLevel: 'write',
    summary: 'Telgea cost threshold set.',
    upstream: [{ method: 'PUT', path: '/v1/cost-thresholds' }],
    input: {
      usageType,
      teamId: uuid.optional(),
      userId: uuid.optional(),
      maxAmount: z.number().min(0).max(1_000_000).describe('Monthly cap in the organisation’s currency.'),
    },
    async run(client, input) {
      if (input.teamId !== undefined && input.userId !== undefined) throw new Error('Give teamId or userId, not both.');
      const body = query(input, ['usageType', 'teamId', 'userId', 'maxAmount']);
      return pick(await client.send('PUT', '/v1/cost-thresholds', body), {
        threshold: objectOf(THRESHOLD),
        appliesFromNextMonth: plain,
        releasedNumberCount: plain,
      });
    },
  },
  {
    name: 'set_data_restriction',
    title: 'Restrict or restore Telgea data',
    description:
      'Turn mobile data off (restrict) or back on (restore) for one line (numberId) or every line of a user (userId). Calls and SMS keep working.',
    riskLevel: 'write',
    summary: 'Telgea data restriction changed.',
    upstream: [
      { method: 'POST', path: '/v1/numbers/{numberId}/data-restriction' },
      { method: 'DELETE', path: '/v1/numbers/{numberId}/data-restriction' },
      { method: 'POST', path: '/v1/user-plans/{userId}/data-restriction' },
      { method: 'DELETE', path: '/v1/user-plans/{userId}/data-restriction' },
    ],
    input: { numberId: uuid.optional(), userId: uuid.optional(), action: z.enum(['restrict', 'restore']) },
    async run(client, input) {
      if ((input.numberId === undefined) === (input.userId === undefined)) {
        throw new Error('Give exactly one of numberId or userId.');
      }
      const path =
        input.numberId !== undefined
          ? `/v1/numbers/${segment(input.numberId)}/data-restriction`
          : `/v1/user-plans/${segment(input.userId)}/data-restriction`;
      const result = input.action === 'restrict' ? await client.send('POST', path, {}) : await client.send('DELETE', path);
      return { action: input.action, ...pick(result, { effectiveAt: plain }), ...countOf(result) };
    },
  },
  {
    name: 'set_line_suspension',
    title: 'Suspend or restore Telgea line',
    description:
      'Suspend one line (no calls, SMS or data, for example for a lost phone) or restore a suspended line. The number and the SIM are kept.',
    riskLevel: 'write',
    summary: 'Telgea line suspension changed.',
    upstream: [
      { method: 'POST', path: '/v1/numbers/{numberId}/suspension' },
      { method: 'DELETE', path: '/v1/numbers/{numberId}/suspension' },
    ],
    input: { numberId: uuid, action: z.enum(['suspend', 'restore']) },
    async run(client, input) {
      const path = `/v1/numbers/${segment(input.numberId)}/suspension`;
      if (input.action === 'suspend') await client.send('POST', path);
      else await client.send('DELETE', path);
      return { numberId: input.numberId, action: input.action, accepted: true };
    },
  },
];

/** How many numbers a data restriction reached, without the numbers themselves. */
function countOf(result: unknown): { numberCount?: number } {
  const list = asObject(result)?.numbers;
  return Array.isArray(list) ? { numberCount: list.length } : {};
}
