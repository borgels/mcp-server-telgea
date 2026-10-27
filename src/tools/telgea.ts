import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { formatUnknownError } from '../errors.js';
import { writeAuditEvent } from '../telgea/audit.js';
import {
  DESTRUCTIVE_TOOL_ANNOTATIONS,
  READ_TOOL_ANNOTATIONS,
  TELGEA_CAPABILITIES,
  WRITE_TOOL_ANNOTATIONS,
  searchCapabilities,
} from '../telgea/capabilities.js';
import { pathSegment, type TelgeaClient } from '../telgea/client.js';
import {
  CHANGE_KINDS,
  commitPreparedOperation,
  prepareChange,
  previewForAudit,
  verifyPreparedOperation,
  type PreparedOperation,
  type TelgeaChange,
} from '../telgea/operations.js';
import { MAX_PAGES_LIMIT, fetchCursorPages, fetchPages } from '../telgea/pagination.js';
import { checkToolPolicy, simSecretsEnabled, writesEnabled } from '../telgea/policy.js';
import { redactSimSecrets, SIM_SECRET_FIELDS } from '../telgea/redact.js';

export interface TelgeaToolContext {
  /** Gateway-verified user (X-MCP-User), or the stdio default. */
  actingAs?: string;
}

const uuid = (what: string) => z.guid().describe(what);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const country = z.string().trim().regex(/^[A-Za-z]{2}$/, 'ISO 3166-1 alpha-2, e.g. DK').transform(value => value.toUpperCase());
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
const reasonSchema = z.string().trim().min(3).max(500).describe('Why — kept in the audit log (and with Telgea where the endpoint takes a reason).');

const pageShape = (maxPageSize: number) => ({
  page: z.number().int().min(1).optional().describe('Page to start at (1-based). Use nextPage from a previous result to continue.'),
  pageSize: z.number().int().min(1).max(maxPageSize).optional().describe(`Items per page (max ${maxPageSize}).`),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGES_LIMIT)
    .optional()
    .describe(`Pages to fetch in this call (default 1, max ${MAX_PAGES_LIMIT}). Each page is one request against the daily budget.`),
});

export function registerTelgeaTools(server: McpServer, client: TelgeaClient, context: TelgeaToolContext = {}): void {
  const actingAs = context.actingAs;

  const describe = (id: string) => {
    const capability = TELGEA_CAPABILITIES.find(item => item.id === id);
    if (!capability) throw new Error(`No capability entry for ${id}`);
    const notes = capability.safetyNotes.length ? ` ${capability.safetyNotes.join(' ')}` : '';
    return { title: capability.title, description: `${capability.description}${notes}` };
  };

  const run = <T>(tool: string, input: unknown, call: () => Promise<T>, extra: { operationHash?: string; target?: unknown } = {}) =>
    runAuditedTool(tool, input, actingAs, call, extra);

  // --- discovery ---------------------------------------------------------

  server.registerTool(
    'telgea_search_capabilities',
    {
      ...describe('telgea_search_capabilities'),
      inputSchema: {
        query: z.string().trim().default(''),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_search_capabilities', input, async () => jsonToolResult(searchCapabilities(input.query, input.limit))),
  );

  server.registerTool(
    'telgea_server_status',
    {
      ...describe('telgea_server_status'),
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_server_status', input, async () =>
        jsonToolResult({
          apiKeyConfigured: client.configured,
          baseUrl: client.baseUrl,
          actingAs: actingAs ?? null,
          writesEnabled: writesEnabled(),
          simSecretsEnabled: simSecretsEnabled(),
          requestBudget: client.budget.status(),
        }),
      ),
  );

  // --- users & teams -----------------------------------------------------

  server.registerTool(
    'telgea_list_users',
    {
      ...describe('telgea_list_users'),
      inputSchema: {
        email: z.email().optional().describe('Exact email.'),
        employeeId: z.string().trim().min(1).optional().describe('Exact employee id.'),
        ...pageShape(50),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_list_users', input, async () =>
        jsonToolResult(
          await fetchPages(client, '/v1/users', { email: input.email, employeeId: input.employeeId }, input),
        ),
      ),
  );

  server.registerTool(
    'telgea_get_user_cost_threshold',
    {
      ...describe('telgea_get_user_cost_threshold'),
      inputSchema: { userId: uuid('User id.'), usageType },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_get_user_cost_threshold', input, async () =>
        jsonToolResult(
          await client.get(
            `/v1/users/${pathSegment(input.userId, 'userId')}/cost-thresholds/${pathSegment(input.usageType, 'usageType')}`,
          ),
        ),
      ),
  );

  server.registerTool(
    'telgea_list_teams',
    {
      ...describe('telgea_list_teams'),
      inputSchema: { ...pageShape(50) },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => run('telgea_list_teams', input, async () => jsonToolResult(await fetchPages(client, '/v1/teams', {}, input))),
  );

  server.registerTool(
    'telgea_create_user',
    {
      ...describe('telgea_create_user'),
      inputSchema: {
        email: z.email(),
        firstName: z.string().trim().min(1),
        lastName: z.string().trim().min(1),
        teamId: uuid('Team id (telgea_list_teams). Defaults to the default team.').optional(),
        costCode: z.string().trim().min(1).optional(),
        employeeId: z.string().trim().min(1).optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_create_user', input, async () => jsonToolResult(await client.send('POST', '/v1/users', { body: input }))),
  );

  server.registerTool(
    'telgea_update_user',
    {
      ...describe('telgea_update_user'),
      inputSchema: {
        userId: uuid('User id.'),
        email: z.email().optional(),
        firstName: z.string().trim().min(1).optional(),
        lastName: z.string().trim().min(1).optional(),
        teamId: uuid('Team id.').optional(),
        costCode: z.string().trim().min(1).optional(),
        employeeId: z.string().trim().min(1).optional(),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_update_user', input, async () => {
        const { userId, ...patch } = input;
        requireSomeField(patch);
        await client.send('PATCH', `/v1/users/${pathSegment(userId, 'userId')}`, { body: patch });
        return jsonToolResult({ updated: true, userId, fields: Object.keys(patch) });
      }),
  );

  server.registerTool(
    'telgea_create_team',
    {
      ...describe('telgea_create_team'),
      inputSchema: {
        name: z.string().trim().min(1),
        emoji: z.string().trim().min(1).optional(),
        costCode: z.string().trim().min(1).optional(),
        userIds: z.array(z.guid()).optional().describe('Initial members.'),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_create_team', input, async () => jsonToolResult(await client.send('POST', '/v1/teams', { body: input }))),
  );

  server.registerTool(
    'telgea_update_team',
    {
      ...describe('telgea_update_team'),
      inputSchema: {
        teamId: uuid('Team id.'),
        name: z.string().trim().min(1).optional(),
        emoji: z.string().trim().min(1).optional(),
        costCode: z.string().trim().min(1).optional(),
        userIds: z.array(z.guid()).optional().describe('Replaces the entire member list.'),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_update_team', input, async () => {
        const { teamId, ...patch } = input;
        requireSomeField(patch);
        await client.send('PATCH', `/v1/teams/${pathSegment(teamId, 'teamId')}`, { body: patch });
        return jsonToolResult({ updated: true, teamId, fields: Object.keys(patch) });
      }),
  );

  // --- plans & lines -----------------------------------------------------

  server.registerTool(
    'telgea_list_user_plans',
    {
      ...describe('telgea_list_user_plans'),
      inputSchema: {
        orderBy: z.enum(['firstName', 'localPhoneNumber', 'status', 'teamName']).optional(),
        orderDirection: z.enum(['asc', 'desc']).optional(),
        // The spec says 100, but the live API answers 400 above 50.
        ...pageShape(50),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_list_user_plans', input, async () =>
        jsonToolResult(
          await fetchPages(client, '/v1/user-plans', { orderBy: input.orderBy, orderDirection: input.orderDirection }, input),
        ),
      ),
  );

  server.registerTool(
    'telgea_find_user_plan',
    {
      ...describe('telgea_find_user_plan'),
      inputSchema: {
        email: z.email().optional(),
        msisdn: z.string().trim().regex(/^\+\d{6,15}$/, 'E.164, e.g. +4512345678').optional(),
        iccid: z.string().trim().regex(/^\d{18,22}F?$/i, 'ICCID digits').optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_find_user_plan', input, async () => {
        const given = [input.email, input.msisdn, input.iccid].filter(Boolean).length;
        if (given !== 1) {
          throw new Error('Give exactly one of email, msisdn or iccid.');
        }
        return jsonToolResult(redactSimSecrets(await client.get('/v1/user-plans/search', input)));
      }),
  );

  server.registerTool(
    'telgea_get_user_plan',
    {
      ...describe('telgea_get_user_plan'),
      inputSchema: { userId: uuid('User id (the plan is addressed by its user).') },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_get_user_plan', input, async () =>
        jsonToolResult(redactSimSecrets(await client.get(`/v1/user-plans/${pathSegment(input.userId, 'userId')}`))),
      ),
  );

  server.registerTool(
    'telgea_list_lines',
    {
      ...describe('telgea_list_lines'),
      inputSchema: {
        msisdn: z.string().trim().regex(/^\+\d{6,15}$/, 'E.164').optional(),
        iccid: z.string().trim().min(10).optional(),
        userId: uuid('Only this user’s lines.').optional(),
        type: z.enum(['local', 'travel']).optional(),
        state: lineState.optional(),
        orderBy: z.enum(['createdAt', 'phoneNumber', 'type']).optional(),
        orderDirection: z.enum(['asc', 'desc']).optional(),
        ...pageShape(100),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_list_lines', input, async () => {
        const { page, pageSize, maxPages, ...filters } = input;
        return jsonToolResult(redactSimSecrets(await fetchPages(client, '/v1/numbers', filters, { page, pageSize, maxPages })));
      }),
  );

  server.registerTool(
    'telgea_get_line',
    {
      ...describe('telgea_get_line'),
      inputSchema: { numberId: uuid('Line id (telgea_list_lines / telgea_get_user_plan).') },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_get_line', input, async () =>
        jsonToolResult(redactSimSecrets(await client.get(`/v1/numbers/${pathSegment(input.numberId, 'numberId')}`))),
      ),
  );

  server.registerTool(
    'telgea_get_line_connection',
    {
      ...describe('telgea_get_line_connection'),
      inputSchema: { numberId: uuid('Line id.') },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_get_line_connection', input, async () =>
        jsonToolResult(await client.get(`/v1/numbers/${pathSegment(input.numberId, 'numberId')}/connection`)),
      ),
  );

  server.registerTool(
    'telgea_get_sim_credentials',
    {
      ...describe('telgea_get_sim_credentials'),
      inputSchema: {
        numberId: uuid('Line id.'),
        reason: reasonSchema,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_get_sim_credentials', input, async () => {
        const line = await client.get<Record<string, unknown>>(`/v1/numbers/${pathSegment(input.numberId, 'numberId')}`);
        const sim = (line?.sim ?? {}) as Record<string, unknown>;
        const credentials = Object.fromEntries(SIM_SECRET_FIELDS.map(field => [field, sim[field] ?? null]));
        return jsonToolResult({
          numberId: line?.id,
          phoneNumber: line?.phoneNumber,
          state: line?.state,
          userId: line?.userId,
          iccid: sim.iccid ?? null,
          ...credentials,
        });
      }),
  );

  server.registerTool(
    'telgea_set_line_suspension',
    {
      ...describe('telgea_set_line_suspension'),
      inputSchema: {
        numberId: uuid('Line id.'),
        action: z.enum(['suspend', 'restore']),
        reason: reasonSchema,
      },
      annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_set_line_suspension', input, async () => {
        const path = `/v1/numbers/${pathSegment(input.numberId, 'numberId')}/suspension`;
        await client.send(input.action === 'suspend' ? 'POST' : 'DELETE', path);
        return jsonToolResult({ numberId: input.numberId, action: input.action, accepted: true });
      }),
  );

  server.registerTool(
    'telgea_set_data_restriction',
    {
      ...describe('telgea_set_data_restriction'),
      inputSchema: {
        numberId: uuid('One line.').optional(),
        userId: uuid('Every line of this user.').optional(),
        action: z.enum(['restrict', 'restore']),
        reason: reasonSchema,
      },
      annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_set_data_restriction', input, async () => {
        if (Boolean(input.numberId) === Boolean(input.userId)) {
          throw new Error('Give exactly one of numberId or userId.');
        }
        const base = input.numberId
          ? `/v1/numbers/${pathSegment(input.numberId, 'numberId')}`
          : `/v1/user-plans/${pathSegment(input.userId!, 'userId')}`;
        const result =
          input.action === 'restrict'
            ? await client.send('POST', `${base}/data-restriction`, { body: { reason: input.reason } })
            : await client.send('DELETE', `${base}/data-restriction`, { query: { reason: input.reason } });
        return jsonToolResult(result);
      }),
  );

  // --- port-ins ----------------------------------------------------------

  server.registerTool(
    'telgea_get_port_in_requirements',
    {
      ...describe('telgea_get_port_in_requirements'),
      inputSchema: {
        countryCode: country,
        format: z.enum(['fields', 'schema']).default('fields'),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_get_port_in_requirements', input, async () => {
        const base = `/v1/port-ins/fields/${pathSegment(input.countryCode, 'countryCode')}`;
        return jsonToolResult(await client.get(input.format === 'schema' ? `${base}/schema` : base));
      }),
  );

  server.registerTool(
    'telgea_validate_port_in',
    {
      ...describe('telgea_validate_port_in'),
      inputSchema: {
        countryCode: country,
        type: z.string().trim().min(1).describe('Port-in type from telgea_get_port_in_requirements (e.g. private/business).'),
        msisdn: z.string().trim().regex(/^\+\d{6,15}$/, 'E.164'),
        executionDate: isoDate,
        fields: z.record(z.string(), z.unknown()).describe('Country-specific fields from telgea_get_port_in_requirements.'),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_validate_port_in', input, async () =>
        jsonToolResult(await client.send('POST', '/v1/port-ins/validate', { body: input })),
      ),
  );

  server.registerTool(
    'telgea_get_port_in',
    {
      ...describe('telgea_get_port_in'),
      inputSchema: { portInId: uuid('Port-in id.') },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_get_port_in', input, async () =>
        jsonToolResult(await client.get(`/v1/port-ins/${pathSegment(input.portInId, 'portInId')}`)),
      ),
  );

  server.registerTool(
    'telgea_list_port_ins_for_line',
    {
      ...describe('telgea_list_port_ins_for_line'),
      inputSchema: { numberId: uuid('Line id.'), ...pageShape(100) },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_list_port_ins_for_line', input, async () =>
        jsonToolResult(
          await fetchPages(client, `/v1/port-ins/number/${pathSegment(input.numberId, 'numberId')}`, {}, input),
        ),
      ),
  );

  // --- usage, analytics, pools, rates ------------------------------------

  server.registerTool(
    'telgea_list_usage',
    {
      ...describe('telgea_list_usage'),
      inputSchema: {
        startDate: isoDate.describe('Inclusive, UTC.'),
        endDate: isoDate.describe('Inclusive, UTC. At most 31 days after startDate.'),
        userId: uuid('Only this user.').optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
        cursor: z.string().trim().min(1).optional().describe('nextCursor from a previous result.'),
        maxPages: z.number().int().min(1).max(MAX_PAGES_LIMIT).optional().describe('Default 1.'),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_list_usage', input, async () => {
        assertWindow(input.startDate, input.endDate, 31);
        return jsonToolResult(
          await fetchCursorPages(
            client,
            '/v1/usage',
            { startDate: input.startDate, endDate: input.endDate, userId: input.userId, pageSize: input.pageSize },
            input,
          ),
        );
      }),
  );

  server.registerTool(
    'telgea_get_usage_analytics',
    {
      ...describe('telgea_get_usage_analytics'),
      inputSchema: {
        startDate: isoDate,
        endDate: isoDate,
        interval: z.enum(['month', 'day']),
        userId: uuid('Only this user.').optional(),
        msisdn: z.string().trim().regex(/^\+\d{6,15}$/, 'E.164').optional(),
        countryIsoCode: country.optional().describe('Only usage served in this country.'),
        orderBy: z.enum(['asc', 'desc']).optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_get_usage_analytics', input, async () => {
        assertWindow(input.startDate, input.endDate);
        return jsonToolResult(await client.get('/v1/analytics', input));
      }),
  );

  server.registerTool(
    'telgea_list_data_pools',
    {
      ...describe('telgea_list_data_pools'),
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => run('telgea_list_data_pools', input, async () => jsonToolResult(await client.get('/v1/data-pools'))),
  );

  server.registerTool(
    'telgea_list_data_pool_members',
    {
      ...describe('telgea_list_data_pool_members'),
      inputSchema: { poolId: uuid('Data pool id.') },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_list_data_pool_members', input, async () =>
        jsonToolResult(await client.get(`/v1/data-pools/${pathSegment(input.poolId, 'poolId')}/members`)),
      ),
  );

  server.registerTool(
    'telgea_list_rates',
    {
      ...describe('telgea_list_rates'),
      inputSchema: {
        market: country.describe('Home market, e.g. DK.'),
        type: z.enum(['INTL_VOICE', 'INTL_SMS', 'INTL_MMS', 'ROAMING_DATA']),
        servingCountry: country.optional().describe('Where the subscriber is, when roaming.'),
        direction: z.enum(['outbound', 'inbound']).optional(),
        asOfDate: isoDate.optional(),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input => run('telgea_list_rates', input, async () => jsonToolResult(await client.get('/v1/rates', input))),
  );

  // --- cost thresholds ---------------------------------------------------

  const thresholdScope = {
    teamId: uuid('Team the threshold is for. Omit teamId and userId for the organisation.').optional(),
    userId: uuid('User the threshold is for. Omit teamId and userId for the organisation.').optional(),
  };

  server.registerTool(
    'telgea_list_cost_thresholds',
    {
      ...describe('telgea_list_cost_thresholds'),
      inputSchema: { usageType: usageType.optional(), ...thresholdScope },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_list_cost_thresholds', input, async () => jsonToolResult(await client.get('/v1/cost-thresholds', input))),
  );

  server.registerTool(
    'telgea_set_cost_threshold',
    {
      ...describe('telgea_set_cost_threshold'),
      inputSchema: {
        usageType,
        ...thresholdScope,
        maxAmount: z.number().min(0).describe('Monthly cap in the organisation’s currency.'),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_set_cost_threshold', input, async () => {
        assertOneScope(input);
        return jsonToolResult(await client.send('PUT', '/v1/cost-thresholds', { body: input }));
      }),
  );

  server.registerTool(
    'telgea_remove_cost_threshold',
    {
      ...describe('telgea_remove_cost_threshold'),
      inputSchema: { usageType, ...thresholdScope },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_remove_cost_threshold', input, async () => {
        assertOneScope(input);
        await client.send('DELETE', '/v1/cost-thresholds', { query: input });
        return jsonToolResult({ removed: true, ...input });
      }),
  );

  // --- two-step changes --------------------------------------------------

  server.registerTool(
    'telgea_prepare_change',
    {
      ...describe('telgea_prepare_change'),
      inputSchema: {
        kind: z.enum(CHANGE_KINDS),
        reason: reasonSchema,
        userId: uuid('create_user_plan, add_line, terminate_plan, delete_user, submit_port_in.').optional(),
        numberId: uuid('replace_sim, terminate_line.').optional(),
        portInId: uuid('discard_port_in.').optional(),
        countryCode: country.optional().describe('create_user_plan, add_line, submit_port_in.'),
        terminationDate: isoDate.optional().describe('terminate_line, terminate_plan. Today or later.'),
        deleteUser: z.boolean().optional().describe('terminate_line, terminate_plan: also delete the user afterwards.'),
        msisdn: z.string().trim().regex(/^\+\d{6,15}$/, 'E.164').optional().describe('submit_port_in.'),
        executionDate: isoDate.optional().describe('submit_port_in.'),
        portInType: z.string().trim().min(1).optional().describe('submit_port_in: type from telgea_get_port_in_requirements.'),
        fields: z.record(z.string(), z.unknown()).optional().describe('submit_port_in: country-specific fields.'),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      run('telgea_prepare_change', input, async () => {
        const operation = await prepareChange(client, toChange(input), {
          reason: input.reason,
          actingAs: requireActingAs(actingAs),
        });
        return jsonToolResult({
          operation,
          next: 'Show the preview and warnings to the user. Only after an explicit yes, call telgea_commit_prepared_operation with this operation unchanged and confirmOperationHash = operation.operationHash.',
        });
      }),
  );

  server.registerTool(
    'telgea_commit_prepared_operation',
    {
      ...describe('telgea_commit_prepared_operation'),
      inputSchema: {
        operation: z.looseObject({ operationHash: z.string() }).describe('The operation object from telgea_prepare_change, unchanged.'),
        confirmOperationHash: z.string().trim().min(1),
      },
      annotations: DESTRUCTIVE_TOOL_ANNOTATIONS,
    },
    async input => {
      const operation = input.operation as unknown as PreparedOperation;
      return run(
        'telgea_commit_prepared_operation',
        input,
        async () => {
          verifyPreparedOperation(operation, {
            confirmOperationHash: input.confirmOperationHash,
            actingAs: requireActingAs(actingAs),
          });
          return jsonToolResult(await commitPreparedOperation(client, operation));
        },
        { operationHash: input.confirmOperationHash, target: previewForAuditSafe(operation) },
      );
    },
  );
}

function toChange(input: {
  kind: (typeof CHANGE_KINDS)[number];
  userId?: string;
  numberId?: string;
  portInId?: string;
  countryCode?: string;
  terminationDate?: string;
  deleteUser?: boolean;
  msisdn?: string;
  executionDate?: string;
  portInType?: string;
  fields?: Record<string, unknown>;
}): TelgeaChange {
  const need = <K extends keyof typeof input>(key: K): NonNullable<(typeof input)[K]> => {
    const value = input[key];
    if (value === undefined || value === null || value === '') {
      throw new Error(`${String(key)} is required for kind=${input.kind}.`);
    }
    return value as NonNullable<(typeof input)[K]>;
  };

  switch (input.kind) {
    case 'create_user_plan':
    case 'add_line':
      return { kind: input.kind, userId: need('userId'), countryCode: need('countryCode') };
    case 'replace_sim':
      return { kind: 'replace_sim', numberId: need('numberId') };
    case 'terminate_line':
      return { kind: 'terminate_line', numberId: need('numberId'), terminationDate: need('terminationDate'), deleteUser: input.deleteUser };
    case 'terminate_plan':
      return { kind: 'terminate_plan', userId: need('userId'), terminationDate: need('terminationDate'), deleteUser: input.deleteUser };
    case 'delete_user':
      return { kind: 'delete_user', userId: need('userId') };
    case 'submit_port_in':
      return {
        kind: 'submit_port_in',
        userId: need('userId'),
        countryCode: need('countryCode'),
        msisdn: need('msisdn'),
        executionDate: need('executionDate'),
        type: need('portInType'),
        fields: need('fields'),
      };
    case 'discard_port_in':
      return { kind: 'discard_port_in', portInId: need('portInId') };
  }
}

/**
 * Prepared operations are bound to a person. Over HTTP that is the
 * gateway-verified user; over stdio TELGEA_DEFAULT_USER (or "local").
 */
function requireActingAs(actingAs: string | undefined): string {
  const value = actingAs ?? process.env.TELGEA_DEFAULT_USER ?? 'local';
  if (!value.trim()) {
    throw new Error('No requesting user identity available.');
  }
  return value.trim().toLowerCase();
}

function requireSomeField(patch: Record<string, unknown>): void {
  if (!Object.values(patch).some(value => value !== undefined)) {
    throw new Error('Nothing to change: give at least one field.');
  }
}

function assertOneScope(input: { teamId?: string; userId?: string }): void {
  if (input.teamId && input.userId) {
    throw new Error('Give teamId or userId, not both (omit both for the organisation).');
  }
}

function assertWindow(startDate: string, endDate: string, maxDays?: number): void {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new Error('startDate and endDate must be valid YYYY-MM-DD dates.');
  }
  if (end < start) {
    throw new Error('endDate is before startDate.');
  }
  if (maxDays !== undefined && (end - start) / 86_400_000 + 1 > maxDays) {
    throw new Error(`The window may span at most ${maxDays} days; split the request.`);
  }
}

function previewForAuditSafe(operation: PreparedOperation): unknown {
  try {
    return previewForAudit(operation);
  } catch {
    return undefined;
  }
}

async function runAuditedTool<T>(
  tool: string,
  input: unknown,
  actingAs: string | undefined,
  call: () => Promise<T>,
  extra: { operationHash?: string; target?: unknown } = {},
): Promise<T> {
  const policy = checkToolPolicy(tool);
  const target = extra.target ?? auditTarget(input);

  if (!policy.allowed) {
    await writeAuditEvent({ tool, actingAs, action: 'policy_denied', target, reason: policy.reason });
    throw new Error(policy.reason);
  }

  await writeAuditEvent({ tool, actingAs, action: 'start', target, reason: policy.reason, operationHash: extra.operationHash });

  try {
    const result = await call();
    await writeAuditEvent({ tool, actingAs, action: 'finish', target, status: 'ok', operationHash: extra.operationHash });
    return result;
  } catch (error) {
    await writeAuditEvent({
      tool,
      actingAs,
      action: 'error',
      target,
      status: 'error',
      error: formatUnknownError(error),
      operationHash: extra.operationHash,
    });
    throw error;
  }
}

function auditTarget(input: unknown): unknown {
  if (!input || typeof input !== 'object') {
    return input;
  }

  const value = input as Record<string, unknown>;
  return {
    kind: value.kind,
    userId: value.userId,
    teamId: value.teamId,
    numberId: value.numberId,
    portInId: value.portInId,
    poolId: value.poolId,
    action: value.action,
    usageType: value.usageType,
    msisdn: value.msisdn,
    email: value.email,
    reason: value.reason,
    startDate: value.startDate,
    endDate: value.endDate,
  };
}

function jsonToolResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data ?? null, null, 2),
      },
    ],
  };
}
