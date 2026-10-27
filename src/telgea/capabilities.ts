export type CapabilityRisk = 'read' | 'write' | 'destructive' | 'sensitive';

export interface TelgeaCapability {
  id: string;
  title: string;
  description: string;
  risk: CapabilityRisk;
  examples: unknown[];
  safetyNotes: string[];
  keywords: string[];
}

export const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export const DESTRUCTIVE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const BUDGET_NOTE = 'Each call spends Telgea requests from the 1000/day budget shared by everyone using the key.';
const WRITE_NOTE = 'Requires TELGEA_ENABLE_WRITES=true on the server.';
const SIM_NOTE = 'eSIM activation codes and PIN/PUK are redacted; use telgea_get_sim_credentials if you are allowed to see them.';

export const TELGEA_CAPABILITIES: TelgeaCapability[] = [
  {
    id: 'telgea_search_capabilities',
    title: 'Search Telgea Capabilities',
    description: 'Find the Telgea tool to use. Does not call Telgea.',
    risk: 'read',
    examples: [{ query: 'suspend line' }],
    safetyNotes: ['Discovery only.'],
    keywords: ['discover', 'help', 'tools'],
  },
  {
    id: 'telgea_server_status',
    title: 'Telgea Server Status',
    description: 'Show which tiers are enabled on this instance and how much of the daily request budget is used. Does not call Telgea.',
    risk: 'read',
    examples: [{}],
    safetyNotes: ['Discovery only.'],
    keywords: ['status', 'budget', 'rate limit', 'quota', 'config', 'whoami'],
  },
  {
    id: 'telgea_list_users',
    title: 'List Users',
    description: 'List the organisation’s users (employees): name, email, team, employee id, cost code. Filter by exact email or employeeId.',
    risk: 'read',
    examples: [{}, { email: 'jane@example.com' }],
    safetyNotes: [BUDGET_NOTE],
    keywords: ['users', 'employees', 'medarbejdere', 'people', 'brugere'],
  },
  {
    id: 'telgea_get_user_cost_threshold',
    title: 'Get User Cost Threshold',
    description: 'A user’s effective cost threshold for DATA, VOICE (international calls), SMS or MMS, current spend this period, and whether usage is paused.',
    risk: 'read',
    examples: [{ userId: '00000000-0000-0000-0000-000000000000', usageType: 'DATA' }],
    safetyNotes: [],
    keywords: ['spend', 'threshold', 'cap', 'forbrug', 'loft', 'paused', 'cost'],
  },
  {
    id: 'telgea_list_teams',
    title: 'List Teams',
    description: 'List teams (billing/access groups) with member counts and cost codes.',
    risk: 'read',
    examples: [{}],
    safetyNotes: [],
    keywords: ['teams', 'departments', 'afdelinger', 'groups', 'cost code'],
  },
  {
    id: 'telgea_list_user_plans',
    title: 'List User Plans',
    description: 'List subscriptions (user plans): user, status (ACTIVE, PROVISIONING, PORTING, TERMINATING…), local number and team. Sortable.',
    risk: 'read',
    examples: [{}, { orderBy: 'status' }],
    safetyNotes: [BUDGET_NOTE],
    keywords: ['plans', 'subscriptions', 'abonnementer', 'overview', 'status'],
  },
  {
    id: 'telgea_find_user_plan',
    title: 'Find User Plan',
    description: 'Find one user’s plan by email, phone number (E.164) or ICCID.',
    risk: 'read',
    examples: [{ msisdn: '+4512345678' }, { email: 'jane@example.com' }],
    safetyNotes: [SIM_NOTE],
    keywords: ['search', 'lookup', 'phone number', 'telefonnummer', 'iccid', 'who has'],
  },
  {
    id: 'telgea_get_user_plan',
    title: 'Get User Plan',
    description: 'Full plan for a user: status, local and travel numbers with line state and SIM ICCID.',
    risk: 'read',
    examples: [{ userId: '00000000-0000-0000-0000-000000000000' }],
    safetyNotes: [SIM_NOTE],
    keywords: ['plan', 'subscription', 'details', 'travel number'],
  },
  {
    id: 'telgea_list_lines',
    title: 'List Lines',
    description: 'List lines (numbers) with type local/travel, state, ICCID and holder. Filter by msisdn, iccid, userId, type or state.',
    risk: 'read',
    examples: [{ state: 'SUSPENDED' }, { userId: '00000000-0000-0000-0000-000000000000' }],
    safetyNotes: [SIM_NOTE, 'Filtering by state costs Telgea more than other filters.'],
    keywords: ['lines', 'numbers', 'numre', 'esim', 'sim', 'msisdn'],
  },
  {
    id: 'telgea_get_line',
    title: 'Get Line',
    description: 'One line: state, timestamps (activated, termination scheduled), current and previous SIMs.',
    risk: 'read',
    examples: [{ numberId: '00000000-0000-0000-0000-000000000000' }],
    safetyNotes: [SIM_NOTE],
    keywords: ['line', 'number', 'sim history'],
  },
  {
    id: 'telgea_get_line_connection',
    title: 'Get Line Connection',
    description: 'Live network status of a line: attached or not, last seen, serving network, 2G–5G, APN, IMEI. For “my phone has no signal” support.',
    risk: 'read',
    examples: [{ numberId: '00000000-0000-0000-0000-000000000000' }],
    safetyNotes: ['IMEI and IP address are device data; share only with the line’s holder or IT.'],
    keywords: ['connection', 'signal', 'network', 'dækning', 'imei', 'roaming', 'support', 'no service'],
  },
  {
    id: 'telgea_get_sim_credentials',
    title: 'Get SIM Credentials',
    description: 'eSIM activation code (LPA string / QR content) and PIN/PUK codes for one line.',
    risk: 'sensitive',
    examples: [{ numberId: '00000000-0000-0000-0000-000000000000' }],
    safetyNotes: [
      'Requires TELGEA_ENABLE_SIM_SECRETS=true on the server.',
      'Anyone with the activation code can install the line on their own phone. Give it only to the line’s holder.',
    ],
    keywords: ['activation code', 'qr', 'esim install', 'pin', 'puk', 'locked sim'],
  },
  {
    id: 'telgea_get_port_in_requirements',
    title: 'Get Port-In Requirements',
    description: 'The fields a number port-in needs for a country, as a field list or a JSON Schema.',
    risk: 'read',
    examples: [{ countryCode: 'DK' }],
    safetyNotes: [],
    keywords: ['port', 'porting', 'nummerflytning', 'transfer number', 'fields'],
  },
  {
    id: 'telgea_validate_port_in',
    title: 'Validate Port-In',
    description: 'Check port-in data against Telgea’s rules without submitting anything.',
    risk: 'read',
    examples: [{ countryCode: 'DK', type: 'business', msisdn: '+4512345678', executionDate: '2026-12-01', fields: {} }],
    safetyNotes: ['Does not submit. Submitting goes through telgea_prepare_change kind=submit_port_in.'],
    keywords: ['port', 'validate', 'check', 'nummerflytning'],
  },
  {
    id: 'telgea_get_port_in',
    title: 'Get Port-In',
    description: 'Status of one port-in (CREATED → SUBMITTED → ACCEPTED → SUCCEEDED, or REJECTED/FAILED with reason).',
    risk: 'read',
    examples: [{ portInId: '00000000-0000-0000-0000-000000000000' }],
    safetyNotes: [],
    keywords: ['port', 'status', 'nummerflytning', 'rejected'],
  },
  {
    id: 'telgea_list_port_ins_for_line',
    title: 'List Port-Ins For Line',
    description: 'All port-in attempts for one line.',
    risk: 'read',
    examples: [{ numberId: '00000000-0000-0000-0000-000000000000' }],
    safetyNotes: [],
    keywords: ['port', 'history'],
  },
  {
    id: 'telgea_list_usage',
    title: 'List Usage Records',
    description: 'Raw call, SMS, MMS and data records with price: timestamps, amount, roaming/international class, counterparty. Window up to 31 days; cursor paging.',
    risk: 'read',
    examples: [{ startDate: '2026-10-01', endDate: '2026-10-31', userId: '00000000-0000-0000-0000-000000000000' }],
    safetyNotes: [
      BUDGET_NOTE,
      'Records include who called whom. Use telgea_get_usage_analytics for totals; reach for raw records only when the detail is needed.',
    ],
    keywords: ['usage', 'cdr', 'calls', 'opkald', 'records', 'roaming', 'billing', 'forbrug'],
  },
  {
    id: 'telgea_get_usage_analytics',
    title: 'Get Usage Analytics',
    description: 'Aggregated data, voice and SMS consumption per day or month, with highest/lowest/average. Filter by user, number or serving country.',
    risk: 'read',
    examples: [{ startDate: '2026-01-01', endDate: '2026-10-31', interval: 'month' }],
    safetyNotes: ['Cheapest way to answer “how much did we use”.'],
    keywords: ['analytics', 'statistics', 'totals', 'trend', 'forbrug', 'data usage', 'consumption'],
  },
  {
    id: 'telgea_list_data_pools',
    title: 'List Data Pools',
    description: 'Shared data pools: region, total/consumed/remaining GB, expiry, whether restrictions are active.',
    risk: 'read',
    examples: [{}],
    safetyNotes: [],
    keywords: ['data pool', 'datapulje', 'gb', 'remaining', 'shared data'],
  },
  {
    id: 'telgea_list_data_pool_members',
    title: 'List Data Pool Members',
    description: 'Members of a data pool with each one’s data use.',
    risk: 'read',
    examples: [{ poolId: '00000000-0000-0000-0000-000000000000' }],
    safetyNotes: [],
    keywords: ['data pool', 'members', 'top users'],
  },
  {
    id: 'telgea_list_rates',
    title: 'List Rates',
    description: 'Pay-as-you-go retail rates for a home market: international voice/SMS/MMS or roaming data, per destination country.',
    risk: 'read',
    examples: [{ market: 'DK', type: 'ROAMING_DATA' }, { market: 'DK', type: 'INTL_VOICE' }],
    safetyNotes: [],
    keywords: ['rates', 'prices', 'priser', 'roaming', 'international', 'cost per minute'],
  },
  {
    id: 'telgea_list_cost_thresholds',
    title: 'List Cost Thresholds',
    description: 'Cost thresholds (monthly spend caps) for the organisation, a team or a user.',
    risk: 'read',
    examples: [{}, { usageType: 'DATA' }],
    safetyNotes: [],
    keywords: ['threshold', 'cap', 'policy', 'spending limit', 'loft'],
  },
  {
    id: 'telgea_create_user',
    title: 'Create User',
    description: 'Create a user (employee) in the organisation. Does not order a plan — that is telgea_prepare_change kind=create_user_plan.',
    risk: 'write',
    examples: [{ email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe' }],
    safetyNotes: [WRITE_NOTE],
    keywords: ['create', 'user', 'onboard', 'opret', 'new employee'],
  },
  {
    id: 'telgea_update_user',
    title: 'Update User',
    description: 'Change a user’s name, email, team, cost code or employee id.',
    risk: 'write',
    examples: [{ userId: '00000000-0000-0000-0000-000000000000', teamId: '00000000-0000-0000-0000-000000000001' }],
    safetyNotes: [WRITE_NOTE],
    keywords: ['update', 'user', 'move team', 'rename', 'ret'],
  },
  {
    id: 'telgea_create_team',
    title: 'Create Team',
    description: 'Create a team, optionally with members.',
    risk: 'write',
    examples: [{ name: 'Sales', costCode: '4100' }],
    safetyNotes: [WRITE_NOTE],
    keywords: ['team', 'create', 'opret'],
  },
  {
    id: 'telgea_update_team',
    title: 'Update Team',
    description: 'Rename a team, change its cost code/emoji, or replace its member list.',
    risk: 'write',
    examples: [{ teamId: '00000000-0000-0000-0000-000000000000', name: 'Sales DK' }],
    safetyNotes: [WRITE_NOTE, 'userIds replaces the whole member list.'],
    keywords: ['team', 'update', 'members'],
  },
  {
    id: 'telgea_set_cost_threshold',
    title: 'Set Cost Threshold',
    description: 'Set a monthly spend cap on DATA, VOICE (international), SMS or MMS for the organisation, a team or a user. Reaching it pauses that usage.',
    risk: 'write',
    examples: [{ usageType: 'DATA', userId: '00000000-0000-0000-0000-000000000000', maxAmount: 200 }],
    safetyNotes: [WRITE_NOTE, 'May apply from next month; the result says so (appliesFromNextMonth).'],
    keywords: ['threshold', 'cap', 'limit', 'loft', 'policy', 'roaming'],
  },
  {
    id: 'telgea_remove_cost_threshold',
    title: 'Remove Cost Threshold',
    description: 'Remove a spend cap, releasing paused usage.',
    risk: 'write',
    examples: [{ usageType: 'DATA', userId: '00000000-0000-0000-0000-000000000000' }],
    safetyNotes: [WRITE_NOTE],
    keywords: ['threshold', 'remove', 'unpause'],
  },
  {
    id: 'telgea_set_line_suspension',
    title: 'Suspend / Restore Line',
    description: 'Suspend a line (no calls, SMS or data — e.g. a lost phone) or restore a suspended line.',
    risk: 'destructive',
    examples: [{ numberId: '00000000-0000-0000-0000-000000000000', action: 'suspend' }],
    safetyNotes: [WRITE_NOTE, 'Suspending cuts the holder off completely until restored. Confirm with the user first.'],
    keywords: ['suspend', 'lost phone', 'stolen', 'spær', 'block', 'restore', 'genåbn'],
  },
  {
    id: 'telgea_set_data_restriction',
    title: 'Stop / Restore Mobile Data',
    description: 'Stop or restore mobile data on one line (numberId) or on every line of a user (userId). Calls and SMS keep working.',
    risk: 'destructive',
    examples: [{ userId: '00000000-0000-0000-0000-000000000000', action: 'restrict', reason: 'Roaming bill shock' }],
    safetyNotes: [WRITE_NOTE, 'Confirm with the user first.'],
    keywords: ['data', 'restrict', 'stop data', 'luk data', 'roaming', 'restore'],
  },
  {
    id: 'telgea_prepare_change',
    title: 'Prepare Change',
    description:
      'Step 1 of 2 for what costs money or cannot be undone: create_user_plan, add_line, replace_sim, terminate_line, terminate_plan, delete_user, submit_port_in, discard_port_in. Returns a signed preview; nothing is sent.',
    risk: 'write',
    examples: [{ kind: 'terminate_plan', userId: '00000000-0000-0000-0000-000000000000', terminationDate: '2026-12-31', reason: 'Employee leaving' }],
    safetyNotes: [WRITE_NOTE, 'Show the preview and warnings to the user and get an explicit yes before committing.'],
    keywords: ['order', 'bestil', 'new sim', 'esim', 'terminate', 'opsig', 'port', 'delete', 'offboard', 'replace sim'],
  },
  {
    id: 'telgea_commit_prepared_operation',
    title: 'Commit Prepared Operation',
    description: 'Step 2 of 2: send a prepared operation, unchanged, with its operationHash. Valid for 15 minutes, only for the user who prepared it.',
    risk: 'destructive',
    examples: [{ operation: '<the object from telgea_prepare_change>', confirmOperationHash: '<operationHash>' }],
    safetyNotes: [WRITE_NOTE, 'Committing the same operation twice replays the first result (idempotency key from the hash).'],
    keywords: ['commit', 'confirm', 'execute', 'bekræft'],
  },
];

export function searchCapabilities(query: string, limit = 20): TelgeaCapability[] {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return TELGEA_CAPABILITIES.slice(0, limit);
  }

  return TELGEA_CAPABILITIES.map(capability => ({
    capability,
    score: scoreCapability(capability, normalized),
  }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
    .slice(0, limit)
    .map(item => item.capability);
}

function scoreCapability(capability: TelgeaCapability, query: string): number {
  const haystack = [capability.id, capability.title, capability.description, ...capability.keywords]
    .join(' ')
    .toLowerCase();

  return query
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}
