import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTelgeaGateway,
  GatewayConfigError,
  KEY_REFUSED,
  TELGEA_API_ORIGIN,
  telgeaGatewayTools,
  telgeaToolCatalog,
  type GatewayJsonObject,
  type TelgeaGatewayOptions,
} from '../src/gateway.js';
import { admitsKey } from '../src/key-admission.js';
import { callerPseudonym } from '../src/telgea/gateway-audit.js';

const KEY_A = 'qqqqwwwwzzzzxxxx1';
const KEY_B = 'jjjjkkkkvvvvyyyy2';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const LINE_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_ID = '33333333-3333-4333-8333-333333333333';
const POOL_ID = '44444444-4444-4444-8444-444444444444';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telgea-gateway-'));
  vi.unstubAllEnvs();
  // The MCP server's variables, set as a shared process would have them: an embedded instance must ignore them all.
  vi.stubEnv('TELGEA_API_KEY', 'env-key-must-not-be-used-0000');
  vi.stubEnv('TELGEA_BASE_URL', 'https://env-base.example.org');
  // Not numbers: an instance that read them would throw.
  vi.stubEnv('TELGEA_TIMEOUT_MS', 'not-a-number');
  vi.stubEnv('TELGEA_CACHE_TTL_MS', 'not-a-number');
  vi.stubEnv('TELGEA_DAILY_REQUEST_BUDGET', 'not-a-number');
  vi.stubEnv('TELGEA_ENABLE_WRITES', 'true');
  vi.stubEnv('TELGEA_ENABLE_SIM_SECRETS', 'true');
  vi.stubEnv('TELGEA_AUDIT_LOG', join(dir, 'audit.log'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const SIM = {
  iccid: '8945000000000000001',
  activationCode: 'LPA:1$smdp.example$ACTIVATIONSECRET',
  pinOne: '1234',
  pinTwo: '5678',
  pukOne: '11112222',
  pukTwo: '33334444',
};
const LINE = {
  id: LINE_ID,
  type: 'local',
  countryCode: 'DK',
  phoneNumber: '+4511223344',
  state: 'READY',
  sim: SIM,
  previousSims: [{ iccid: '8945000000000000002', inServiceFrom: '2026-01-01', inServiceTo: '2026-02-01' }],
  userId: USER_ID,
  createdAt: '2026-01-01T00:00:00Z',
  activatedAt: '2026-01-02T00:00:00Z',
};
const PLAN = {
  userId: USER_ID,
  email: 'jane@example.com',
  firstName: 'Jane',
  lastName: 'Doe',
  status: 'ACTIVE',
  teamId: TEAM_ID,
  localNumber: LINE,
  localNumbers: [LINE],
  localNumberCount: 1,
  travelNumber: null,
};

/** A Telgea that answers by path, with SIM data wherever the real one may put it. */
function telgea() {
  return vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? 'GET';
    if (path.endsWith('/suspension')) return new Response(null, { status: 204 });
    if (path.endsWith('/data-restriction')) return jsonResponse({ numbers: ['+4511223344'], effectiveAt: '2026-11-20T10:00:00Z' });
    if (path === '/v1/cost-thresholds' && method === 'PUT') {
      return jsonResponse({ threshold: { id: 'c', usageType: 'VOICE', maxAmount: 100 }, appliesFromNextMonth: false, releasedNumberCount: 0 });
    }
    if (path.startsWith('/v1/user-plans/')) return jsonResponse(PLAN);
    if (path === `/v1/numbers/${LINE_ID}`) return jsonResponse(LINE);
    if (path === '/v1/numbers') return jsonResponse({ page: 1, pageSize: 50, itemsCount: 1, items: [LINE] });
    if (path === '/v1/analytics') {
      return jsonResponse({
        usage: { data: [{ interval: '2026-11', usage: { total: 10, Europe: 10, label: 'x' } }], voice: [], sms: [] },
        metadata: { data: { highest: 10, lowest: 10, average: 10 } },
      });
    }
    if (path === '/v1/data-pools') return jsonResponse({ pools: [{ poolId: POOL_ID, regionName: 'EU', remainingGB: 3 }] });
    if (path.endsWith('/members')) {
      return jsonResponse({ poolId: POOL_ID, members: [{ userId: USER_ID, msisdn: '+4511223344', usageBytes: 5, sim: SIM }] });
    }
    if (path === '/v1/cost-thresholds') return jsonResponse({ thresholds: [{ id: 'c', usageType: 'VOICE' }], currency: 'DKK' });
    if (path.includes('/cost-thresholds/')) return jsonResponse({ threshold: null, spend: null, pausedUntil: null });
    if (path === '/v1/rates') return jsonResponse({ market: 'DK', items: [{ country: 'SE', ratePerUnit: 1 }] });
    return jsonResponse({ page: 1, pageSize: 10, itemsCount: 1, items: [{ id: 'x', name: 'Row', sim: SIM, secret: 'no' }] });
  });
}

function sink() {
  const records: Array<Record<string, unknown>> = [];
  return { records, audit: (record: Readonly<Record<string, unknown>>) => void records.push({ ...record }) };
}

function gateway(fetchImpl: typeof fetch, extra: Partial<TelgeaGatewayOptions> = {}) {
  return createTelgeaGateway({ apiKey: KEY_A, fetchImpl, ...extra });
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

function matches(template: string, path: string): boolean {
  const a = template.split('/');
  const b = path.split('/');
  return a.length === b.length && a.every((part, index) => part.startsWith('{') || part === b[index]);
}

/** One valid input per tool. */
const MINIMAL_INPUT: Record<string, GatewayJsonObject> = {
  search_capabilities: {},
  check_connection: {},
  list_users: {},
  list_teams: {},
  list_user_plans: {},
  get_user_plan: { userId: USER_ID },
  list_lines: {},
  get_line: { numberId: LINE_ID },
  get_usage_analytics: { startDate: '2026-11-01', endDate: '2026-11-20', interval: 'month' },
  list_data_pools: {},
  list_data_pool_members: { poolId: POOL_ID },
  list_rates: { market: 'dk', type: 'INTL_VOICE' },
  list_cost_thresholds: {},
  get_user_cost_threshold: { userId: USER_ID, usageType: 'VOICE' },
  set_cost_threshold: { usageType: 'VOICE', userId: USER_ID, maxAmount: 100 },
  set_data_restriction: { numberId: LINE_ID, action: 'restrict' },
  set_line_suspension: { numberId: LINE_ID, action: 'suspend' },
};
/** Inputs that reach the other upstream requests. */
const MORE_INPUTS: Array<[string, GatewayJsonObject]> = [
  ['get_user_plan', { msisdn: '+4511223344' }],
  ['set_data_restriction', { numberId: LINE_ID, action: 'restore' }],
  ['set_data_restriction', { userId: USER_ID, action: 'restrict' }],
  ['set_data_restriction', { userId: USER_ID, action: 'restore' }],
  ['set_line_suspension', { numberId: LINE_ID, action: 'restore' }],
];
const WRITES = ['set_cost_threshold', 'set_data_restriction', 'set_line_suspension'];

describe('Telgea gateway surface', () => {
  it('uses test keys the gateway admits', () => {
    expect(admitsKey(KEY_A)).toBe(true);
    expect(admitsKey(KEY_B)).toBe(true);
  });

  it('has the agreed tool set: reads enabled by default, writes not, nothing broad', () => {
    expect(telgeaToolCatalog.map(tool => [tool.name, tool.riskLevel, tool.enabledByDefault, tool.broad])).toEqual([
      ['search_capabilities', 'read', true, false],
      ['check_connection', 'read', true, false],
      ['list_users', 'read', true, false],
      ['list_teams', 'read', true, false],
      ['list_user_plans', 'read', true, false],
      ['get_user_plan', 'read', true, false],
      ['list_lines', 'read', true, false],
      ['get_line', 'read', true, false],
      ['get_usage_analytics', 'read', true, false],
      ['list_data_pools', 'read', true, false],
      ['list_data_pool_members', 'read', true, false],
      ['list_rates', 'read', true, false],
      ['list_cost_thresholds', 'read', true, false],
      ['get_user_cost_threshold', 'read', true, false],
      ['set_cost_threshold', 'write', false, false],
      ['set_data_restriction', 'write', false, false],
      ['set_line_suspension', 'write', false, false],
    ]);
    expect(Object.keys(MINIMAL_INPUT).sort()).toEqual(telgeaToolCatalog.map(tool => tool.name).sort());
    const names = telgeaToolCatalog.map(tool => tool.name);
    // SIM data, port-ins, raw usage, live network data and the two-step orders of the MCP server are not in the gateway.
    for (const name of [
      'get_sim_credentials',
      'get_line_connection',
      'list_usage',
      'get_port_in',
      'validate_port_in',
      'list_port_ins_for_line',
      'get_port_in_requirements',
      'prepare_change',
      'commit_prepared_operation',
      'create_user',
      'update_user',
      'create_team',
      'update_team',
      'remove_cost_threshold',
      'server_status',
      'find_user_plan',
    ]) {
      expect(names).not.toContain(name);
    }
    // A DELETE only lifts a restriction or a suspension this gateway can set again.
    for (const tool of telgeaToolCatalog) {
      for (const operation of tool.upstream.filter(entry => entry.method === 'DELETE')) {
        expect(operation.path, tool.name).toMatch(/\/(data-restriction|suspension)$/);
      }
    }
  });

  it('has a deeply frozen catalog equal to the tool definitions, with strict input schemas', () => {
    expect(Object.isFrozen(telgeaToolCatalog)).toBe(true);
    for (const entry of telgeaToolCatalog) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.inputSchema)).toBe(true);
      expect(Object.isFrozen(entry.upstream)).toBe(true);
      for (const operation of entry.upstream) {
        expect(Object.isFrozen(operation)).toBe(true);
        expect(operation.path.startsWith('/v1/')).toBe(true);
      }
      expect(entry.inputSchema.type).toBe('object');
      expect(entry.inputSchema.additionalProperties).toBe(false);
      const { upstream: _upstream, broad: _broad, ...definition } = entry;
      expect(telgeaGatewayTools.find(tool => tool.name === entry.name)).toEqual(definition);
    }
    expect(() => {
      (telgeaToolCatalog[0] as { name: string }).name = 'changed';
    }).toThrow();
  });

  it('takes no SIM, port-in or free-form field in any input', () => {
    for (const tool of telgeaToolCatalog) {
      const fields = Object.keys((tool.inputSchema.properties ?? {}) as object);
      for (const field of ['iccid', 'payload', 'path', 'body', 'reason', 'fields']) expect(fields, tool.name).not.toContain(field);
    }
  });
});

describe('Telgea gateway upstream requests', () => {
  it('sends only the requests the catalog declares for each tool, and reaches each of them', async () => {
    const reached = new Set<string>();
    for (const [name, input] of [...Object.entries(MINIMAL_INPUT), ...MORE_INPUTS]) {
      const fetchImpl = telgea();
      const result = await gateway(fetchImpl, { policy: { enableWrites: true } }).callTool(name, input);
      expect(result.isError, `${name}: ${result.content[0]?.text}`).toBeUndefined();
      const declared = telgeaToolCatalog.find(tool => tool.name === name)!.upstream;
      for (const [url, init] of fetchImpl.mock.calls) {
        expect(String(url).startsWith(`${TELGEA_API_ORIGIN}/v1/`)).toBe(true);
        const method = init?.method ?? 'GET';
        const path = decodeURIComponent(new URL(String(url)).pathname);
        const hit =
          declared.find(operation => operation.method === method && operation.path === path) ??
          declared.find(operation => operation.method === method && matches(operation.path, path));
        expect(hit, `${name}: ${method} ${path}`).toBeDefined();
        reached.add(`${name} ${hit!.method} ${hit!.path}`);
      }
    }
    for (const tool of telgeaToolCatalog) {
      for (const operation of tool.upstream) {
        expect(reached.has(`${tool.name} ${operation.method} ${operation.path}`), `${tool.name} ${operation.path}`).toBe(true);
      }
    }
  });

  it('sends a fresh idempotency key with every change, and only the given fields', async () => {
    const fetchImpl = telgea();
    const g = gateway(fetchImpl, { policy: { enableWrites: true } });
    await g.callTool('set_cost_threshold', { usageType: 'VOICE', teamId: TEAM_ID, maxAmount: 250 });
    await g.callTool('set_cost_threshold', { usageType: 'VOICE', teamId: TEAM_ID, maxAmount: 250 });
    const [first, second] = fetchImpl.mock.calls.map(([, init]) => init!);
    expect(JSON.parse(String(first!.body))).toEqual({ usageType: 'VOICE', teamId: TEAM_ID, maxAmount: 250 });
    expect(headersOf(first)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(headersOf(first)['Idempotency-Key']).not.toBe(headersOf(second)['Idempotency-Key']);
  });

  it('refuses unclear inputs before anything is sent', async () => {
    const fetchImpl = telgea();
    const g = gateway(fetchImpl, { policy: { enableWrites: true } });
    for (const [name, input] of [
      ['get_user_plan', {}],
      ['get_user_plan', { userId: USER_ID, email: 'jane@example.com' }],
      ['set_data_restriction', { action: 'restrict' }],
      ['set_data_restriction', { numberId: LINE_ID, userId: USER_ID, action: 'restrict' }],
      ['set_cost_threshold', { usageType: 'VOICE', teamId: TEAM_ID, userId: USER_ID, maxAmount: 1 }],
      ['get_usage_analytics', { startDate: '2026-11-20', endDate: '2026-11-01', interval: 'day' }],
      ['get_line', { numberId: '../../v1/users' }],
    ] as Array<[string, GatewayJsonObject]>) {
      expect((await g.callTool(name, input)).isError, `${name} ${JSON.stringify(input)}`).toBe(true);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists only what the instance offers in search_capabilities', async () => {
    const result = await gateway(telgea(), { policy: { disabledTools: ['set_line_suspension'] } }).callTool('search_capabilities', {
      query: 'line',
    });
    const names = (result.structuredContent as { tools: Array<{ name: string }> }).tools.map(tool => tool.name);
    expect(names).toContain('telgea_get_line');
    expect(names).not.toContain('telgea_set_line_suspension');
  });
});

describe('Telgea gateway SIM data and personal data in answers', () => {
  it('never returns an ICCID, an activation code, a PIN or a PUK, in any tool', async () => {
    for (const [name, input] of [...Object.entries(MINIMAL_INPUT), ...MORE_INPUTS]) {
      const result = await gateway(telgea(), { policy: { enableWrites: true } }).callTool(name, input);
      const text = JSON.stringify(result);
      for (const secret of [SIM.iccid, '8945000000000000002', 'ACTIVATIONSECRET', SIM.pukOne, SIM.pukTwo, '"pinOne"', '"sim"']) {
        expect(text, `${name}: ${secret}`).not.toContain(secret);
      }
    }
  });

  it('returns a line with number, state and dates, and a plan with its lines, nothing else', async () => {
    const line = await gateway(telgea()).callTool('get_line', { numberId: LINE_ID });
    expect(line.structuredContent).toEqual({
      id: LINE_ID,
      type: 'local',
      countryCode: 'DK',
      phoneNumber: '+4511223344',
      state: 'READY',
      userId: USER_ID,
      createdAt: '2026-01-01T00:00:00Z',
      activatedAt: '2026-01-02T00:00:00Z',
    });
    const plan = await gateway(telgea()).callTool('get_user_plan', { email: 'jane@example.com' });
    const lineView = { id: LINE_ID, type: 'local', countryCode: 'DK', phoneNumber: '+4511223344', state: 'READY' };
    expect(plan.structuredContent).toEqual({
      userId: USER_ID,
      email: 'jane@example.com',
      firstName: 'Jane',
      lastName: 'Doe',
      status: 'ACTIVE',
      teamId: TEAM_ID,
      localNumberCount: 1,
      localNumber: lineView,
      localNumbers: [lineView],
      travelNumber: null,
    });
  });

  it('keeps only numbers in usage buckets, and tells which numbers a restriction reached only as a count', async () => {
    const usage = await gateway(telgea()).callTool('get_usage_analytics', MINIMAL_INPUT.get_usage_analytics!);
    expect(usage.structuredContent).toMatchObject({ usage: { data: [{ interval: '2026-11', usage: { total: 10, Europe: 10 } }] } });
    expect(JSON.stringify(usage)).not.toContain('label');
    const restriction = await gateway(telgea(), { policy: { enableWrites: true } }).callTool('set_data_restriction', MINIMAL_INPUT.set_data_restriction!);
    expect(restriction.structuredContent).toEqual({ action: 'restrict', effectiveAt: '2026-11-20T10:00:00Z', numberCount: 1 });
  });
});

describe('Telgea gateway connection settings', () => {
  it('uses only the key it was given and the fixed address, never TELGEA_*', async () => {
    const fetchImpl = telgea();
    const g = createTelgeaGateway({
      apiKey: KEY_A,
      fetchImpl,
      // Not gateway options: dropped.
      ...({ baseUrl: 'https://elsewhere.example.org', budget: {} } as object),
    } as TelgeaGatewayOptions);
    for (const [name, input] of Object.entries(MINIMAL_INPUT)) await g.callTool(name, input);
    expect(fetchImpl).toHaveBeenCalled();
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(String(url).startsWith('https://api.telgea.com/v1/')).toBe(true);
      expect(headersOf(init)['x-api-key']).toBe(KEY_A);
      expect(init?.redirect).toBe('manual');
    }
    // TELGEA_ENABLE_WRITES=true is set, but the host gave no policy: no writes.
    expect(fetchImpl.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
    expect(existsSync(join(dir, 'audit.log'))).toBe(false);
  });

  it('caches nothing between calls', async () => {
    const fetchImpl = telgea();
    const g = gateway(fetchImpl);
    await g.callTool('list_teams', {});
    await g.callTool('list_teams', {});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('requires the key', () => {
    expect(() => createTelgeaGateway({} as TelgeaGatewayOptions)).toThrow(/requires options.apiKey/);
    expect(() => createTelgeaGateway(undefined as never)).toThrow(GatewayConfigError);
  });

  it('refuses a short key or one that shares text with our own texts, without quoting it', () => {
    for (const apiKey of ['short-key', 'Telgea API request failed with HTTP']) {
      let error: unknown;
      try {
        createTelgeaGateway({ apiKey });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GatewayConfigError);
      expect((error as Error).message).toContain('options.apiKey');
      expect((error as Error).message).not.toContain(apiKey);
      expect((error as Error).stack).not.toMatch(/\n\s+at /);
    }
    expect(KEY_REFUSED).toMatch(/refused/);
  });

  it('never follows a redirect, and does not quote the Location', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.org/x' } }));
    const result = await gateway(fetchImpl).callTool('check_connection', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Telgea API responded with a redirect (HTTP 302) for GET; redirects are not followed.');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses the host’s time limit and words a timeout itself', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
      return jsonResponse({});
    });
    const result = await gateway(fetchImpl, { timeoutMs: 20 }).callTool('check_connection', {});
    expect(result.content[0]!.text).toBe('Telgea API request timed out after 20 ms (GET).');
  });

  it('words a network failure with a code from a fixed list only', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect to 10.0.0.1 failed'), { code: 'ECONNREFUSED' }) });
    });
    const result = await gateway(fetchImpl).callTool('list_teams', {});
    expect(result.content[0]!.text).toBe('Network error calling the Telgea API (GET) (ECONNREFUSED).');
  });
});

describe('Telgea gateway input and tools', () => {
  it('validates input with the tool schema before anything is sent, and refuses unknown fields', async () => {
    const fetchImpl = telgea();
    const g = gateway(fetchImpl);
    for (const [name, input] of [
      ['get_line', { numberId: 'not-a-uuid' }],
      ['list_users', { pageSize: 500 }],
      ['list_lines', { iccid: SIM.iccid }],
      ['list_users', { anything: 1 }],
    ] as Array<[string, GatewayJsonObject]>) {
      const result = await g.callTool(name, input);
      expect(result.isError, name).toBe(true);
      expect(result.content[0]!.text).toMatch(/^Invalid input for /);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses unknown tools and the MCP server tools outside the gateway, and accepts the prefix', async () => {
    const fetchImpl = telgea();
    const g = gateway(fetchImpl);
    for (const name of ['get_sim_credentials', 'telgea_prepare_change', 'list_usage', '', 'x'.repeat(500)]) {
      const result = await g.callTool(name, {});
      expect(result.content[0]!.text).toBe('Unsupported Telgea gateway tool.');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await g.callTool('telgea_list_teams', {})).isError).toBeUndefined();
    expect((await g.callTool('LIST_TEAMS', {})).isError).toBeUndefined();
  });
});

describe('Telgea gateway policy', () => {
  it('without a host policy: reads allowed, no writes, no audit', async () => {
    const fetchImpl = telgea();
    const g = gateway(fetchImpl);
    expect(g.tools.map(tool => tool.name)).toEqual(telgeaToolCatalog.map(tool => tool.name));
    expect((await g.callTool('list_teams', {})).isError).toBeUndefined();
    fetchImpl.mockClear();
    for (const name of WRITES) {
      const result = await g.callTool(name, MINIMAL_INPUT[name]!);
      expect(result.isError, name).toBe(true);
      expect(result.content[0]!.text).toBe('Writes are disabled. The embedding host has not enabled writes for this instance.');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('leaves out and refuses the tools the host disables, and refuses an unknown tool in the policy', async () => {
    const fetchImpl = telgea();
    const g = gateway(fetchImpl, { policy: { enableWrites: true, disabledTools: ['set_line_suspension', 'telgea_list_users'] } });
    expect(g.tools.map(tool => tool.name)).not.toContain('set_line_suspension');
    expect(g.tools.map(tool => tool.name)).not.toContain('list_users');
    const result = await g.callTool('set_line_suspension', MINIMAL_INPUT.set_line_suspension!);
    expect(result.content[0]!.text).toBe('This tool is disabled on this instance by the embedding host.');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => gateway(fetchImpl, { policy: { disabledTools: ['get_sim_credentials'] } })).toThrow(
      'policy.disabledTools[0] is not a known gateway tool.',
    );
    expect(() => gateway(fetchImpl, { policy: { enableWrites: 'yes' as never } })).toThrow(/enableWrites/);
  });

  it('audits to the host’s sink only, with the caller as a pseudonym, and does not run a tool whose start record fails', async () => {
    const fetchImpl = telgea();
    const { records, audit } = sink();
    await gateway(fetchImpl, { policy: { enableWrites: true, audit } }).callTool('set_line_suspension', MINIMAL_INPUT.set_line_suspension!, {
      caller: 'medarbejder@example.com',
      requestId: 'host-request-1',
    });
    expect(records.map(record => record.action)).toEqual(['start', 'finish']);
    expect(records[0]!.caller).toBe(callerPseudonym('medarbejder@example.com'));
    expect(JSON.stringify(records)).not.toContain('medarbejder@example.com');
    expect(JSON.stringify(records)).not.toContain('host-request-1');
    expect(JSON.stringify(records)).not.toContain(LINE_ID);
    expect(existsSync(join(dir, 'audit.log'))).toBe(false);

    const refusing = vi.fn(async () => {
      throw new Error('sink down');
    });
    fetchImpl.mockClear();
    const result = await gateway(fetchImpl, { policy: { enableWrites: true, audit: refusing } }).callTool(
      'set_line_suspension',
      MINIMAL_INPUT.set_line_suspension!,
    );
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Telgea gateway results and errors', () => {
  it('puts the summary, then the data as compact JSON, in the text block, exactly the structured content', async () => {
    const result = await gateway(telgea()).callTool('list_data_pools', {});
    expect(result.structuredContent).toEqual({ pools: [{ poolId: POOL_ID, regionName: 'EU', remainingGB: 3 }] });
    expect(result.content).toEqual([{ type: 'text', text: `Telgea data pools.\n\n${JSON.stringify(result.structuredContent)}` }]);
  });

  it('starts an error with the HTTP status in our own text and never carries the Telgea body', async () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429, 500]) {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        jsonResponse({ title: 'secret internal detail', detail: 'Mette Jensen findes ikke' }, status, { 'retry-after': '30' }),
      );
      const result = await gateway(fetchImpl).callTool('get_line', { numberId: LINE_ID });
      const text = result.content[0]!.text;
      expect(result.isError).toBe(true);
      expect(text.startsWith(`Telgea API request failed with HTTP ${status} (GET).`)).toBe(true);
      expect(text).not.toMatch(/secret internal detail|Jensen/);
      expect(text).toContain('Retry after 30 seconds.');
    }
  });

  it('refuses an answer that is not JSON instead of passing it on', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('<html>login page</html>', { status: 200 }));
    const result = await gateway(fetchImpl).callTool('list_teams', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('Telgea answered with something that is not JSON (GET); nothing of it is passed on.');
  });

  it('redacts the key from values of a result', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ itemsCount: 1, items: [{ id: 't', name: `key ${KEY_A} here`, costCode: KEY_A.slice(2, 10) }] }),
    );
    const result = await gateway(fetchImpl).callTool('list_teams', {});
    const text = JSON.stringify(result);
    expect(text).not.toContain(KEY_A);
    expect(text).not.toContain(KEY_A.slice(2, 8));
  });
});

describe('Telgea gateway tenants and call scopes', () => {
  it('keeps two tenants apart when they call at the same time, each with its own key and sink', async () => {
    const fetchA = vi.fn<typeof fetch>(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return jsonResponse({ itemsCount: 1, items: [{ id: 'a', name: 'a' }] });
    });
    const fetchB = vi.fn<typeof fetch>(async () => jsonResponse({ itemsCount: 1, items: [{ id: 'b', name: 'b' }] }));
    const sinkA = sink();
    const sinkB = sink();
    const a = createTelgeaGateway({ apiKey: KEY_A, fetchImpl: fetchA, policy: { audit: sinkA.audit } });
    const b = createTelgeaGateway({ apiKey: KEY_B, fetchImpl: fetchB, policy: { audit: sinkB.audit, disabledTools: ['list_users'] } });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => (index % 2 === 0 ? a : b).callTool('list_teams', {}, { caller: `user-${index % 2}` })),
    );
    results.forEach((result, index) =>
      expect(result.structuredContent).toEqual({ itemsCount: 1, items: [index % 2 === 0 ? { id: 'a', name: 'a' } : { id: 'b', name: 'b' }] }),
    );
    for (const [, init] of fetchA.mock.calls) expect(headersOf(init)['x-api-key']).toBe(KEY_A);
    for (const [, init] of fetchB.mock.calls) expect(headersOf(init)['x-api-key']).toBe(KEY_B);
    expect(sinkA.records).toHaveLength(10);
    expect(sinkB.records).toHaveLength(10);
    expect(new Set(sinkA.records.map(record => record.caller))).toEqual(new Set([callerPseudonym('user-0')]));
    expect(new Set(sinkB.records.map(record => record.caller))).toEqual(new Set([callerPseudonym('user-1')]));
    expect((await a.callTool('list_users', {})).isError).toBeUndefined();
    expect((await b.callTool('list_users', {})).isError).toBe(true);
  });

  it('runs a call made from inside another instance’s sink under its own scope', async () => {
    const inner = gateway(telgea());
    let innerResult: unknown;
    const outer = gateway(telgea(), {
      policy: {
        enableWrites: true,
        audit: async record => {
          if (record.action === 'start') innerResult = await inner.callTool('set_line_suspension', MINIMAL_INPUT.set_line_suspension!);
        },
      },
    });
    expect((await outer.callTool('set_line_suspension', MINIMAL_INPUT.set_line_suspension!)).isError).toBeUndefined();
    // The inner instance has no writes: the outer policy did not leak into its call.
    expect((innerResult as { isError?: boolean }).isError).toBe(true);
  });

  it('keeps no process-wide registry: an instance’s key is not redacted outside its calls', async () => {
    gateway(telgea());
    const { redactSecrets } = await import('../src/errors.js');
    expect(redactSecrets(`x ${KEY_A} y`)).toBe(`x ${KEY_A} y`);
  });
});
