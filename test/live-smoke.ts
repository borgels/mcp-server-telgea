/**
 * Read-only smoke test against the real Telgea API. Spends about ten
 * requests of the key's 1000/day budget and prints shapes and counts only —
 * no names, numbers or SIM data.
 *
 *   TELGEA_API_KEY=... npm run smoke:live
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

const server = createServer();
const mcp = new Client({ name: 'smoke', version: '0.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  const text = result.content[0]?.text ?? '';
  if (result.isError) {
    console.log(`✗ ${name}: ${text.slice(0, 300)}`);
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function shape(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value && typeof value === 'object') return `{${Object.keys(value).join(', ')}}`;
  return typeof value;
}

const today = new Date().toISOString().slice(0, 10);
const monthStart = `${today.slice(0, 7)}-01`;

const teams = (await call('telgea_list_teams')) as { items?: unknown[]; itemsCount?: number } | undefined;
console.log('teams', teams?.itemsCount, shape(teams?.items?.[0]));

const users = (await call('telgea_list_users', { pageSize: 5 })) as { items?: unknown[]; itemsCount?: number } | undefined;
console.log('users', users?.itemsCount, shape(users?.items?.[0]));

const plans = (await call('telgea_list_user_plans', { pageSize: 5 })) as
  | { items?: Array<{ userId: string; status: string }>; itemsCount?: number }
  | undefined;
console.log('plans', plans?.itemsCount, shape(plans?.items?.[0]));

const lines = (await call('telgea_list_lines', { pageSize: 5 })) as
  | { items?: Array<{ id: string; state: string; sim?: Record<string, unknown> }>; itemsCount?: number }
  | undefined;
console.log('lines', lines?.itemsCount, shape(lines?.items?.[0]));
const firstLine = lines?.items?.[0];
if (firstLine) {
  const redacted = Object.entries(firstLine.sim ?? {})
    .filter(([key]) => key !== 'iccid')
    .every(([, value]) => value === null || value === '' || String(value).startsWith('[redacted'));
  console.log('sim secrets redacted in list:', redacted);
  const line = await call('telgea_get_line', { numberId: firstLine.id });
  console.log('line', shape(line));
  const connection = await call('telgea_get_line_connection', { numberId: firstLine.id });
  console.log('connection', shape(connection));
}

const firstPlan = plans?.items?.[0];
if (firstPlan) {
  console.log('plan', shape(await call('telgea_get_user_plan', { userId: firstPlan.userId })));
}

console.log('analytics', shape(await call('telgea_get_usage_analytics', { startDate: monthStart, endDate: today, interval: 'month' })));
console.log('data pools', shape(await call('telgea_list_data_pools')));
console.log('cost thresholds', shape(await call('telgea_list_cost_thresholds')));
console.log('budget', JSON.stringify(((await call('telgea_server_status')) as { requestBudget?: unknown })?.requestBudget));

await mcp.close();
