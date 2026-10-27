import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { TELGEA_CAPABILITIES } from '../src/telgea/capabilities.js';
import { READ_TOOLS, SIM_SECRET_TOOLS, WRITE_TOOLS } from '../src/telgea/policy.js';
import type { TelgeaClient } from '../src/telgea/client.js';
import { fakeTelgea, LINE, NUMBER_ID, PLAN, USER_ID } from './helpers.js';

async function connect(client: TelgeaClient, onBehalfOf?: string) {
  const server = createServer({ client, onBehalfOf });
  const mcp = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

function text(result: unknown): string {
  return ((result as { content: Array<{ text: string }> }).content[0]?.text ?? '') as string;
}

afterEach(() => {
  delete process.env.TELGEA_ENABLE_WRITES;
  delete process.env.TELGEA_ENABLE_SIM_SECRETS;
});

describe('tool surface', () => {
  it('registers exactly the allowlisted tools, each with a capability entry', async () => {
    const { client } = fakeTelgea(() => ({}));
    const mcp = await connect(client);
    const names = (await mcp.listTools()).tools.map(tool => tool.name).sort();
    const allowlisted = [...READ_TOOLS, ...WRITE_TOOLS, ...SIM_SECRET_TOOLS].sort();
    expect(names).toEqual(allowlisted);
    expect(TELGEA_CAPABILITIES.map(c => c.id).sort()).toEqual(allowlisted);
  });

  it('redacts SIM secrets from line reads', async () => {
    const { client } = fakeTelgea(() => ({ page: 1, pageSize: 50, itemsCount: 1, items: [LINE] }));
    const mcp = await connect(client);
    const result = await mcp.callTool({ name: 'telgea_list_lines', arguments: { userId: USER_ID } });
    expect(text(result)).toContain(LINE.sim.iccid);
    expect(text(result)).not.toContain('SECRET');
    expect(text(result)).not.toContain('"1234"');
  });

  it('gates SIM credentials behind TELGEA_ENABLE_SIM_SECRETS', async () => {
    const { client, seen } = fakeTelgea(() => LINE);
    const mcp = await connect(client);
    const denied = await mcp.callTool({ name: 'telgea_get_sim_credentials', arguments: { numberId: NUMBER_ID, reason: 'New phone' } });
    expect(denied.isError).toBe(true);
    expect(seen).toHaveLength(0);

    process.env.TELGEA_ENABLE_SIM_SECRETS = 'true';
    const allowed = await mcp.callTool({ name: 'telgea_get_sim_credentials', arguments: { numberId: NUMBER_ID, reason: 'New phone' } });
    expect(text(allowed)).toContain('LPA:1$smdp.example$SECRET');
  });

  it('refuses writes unless TELGEA_ENABLE_WRITES=true, without calling Telgea', async () => {
    const { client, seen } = fakeTelgea(() => undefined);
    const mcp = await connect(client);
    const result = await mcp.callTool({
      name: 'telgea_set_line_suspension',
      arguments: { numberId: NUMBER_ID, action: 'suspend', reason: 'Lost phone' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/TELGEA_ENABLE_WRITES/);
    expect(seen).toHaveLength(0);
  });

  it('suspends and restores with POST / DELETE when writes are enabled', async () => {
    process.env.TELGEA_ENABLE_WRITES = 'true';
    const { client, seen } = fakeTelgea(() => undefined);
    const mcp = await connect(client);
    await mcp.callTool({ name: 'telgea_set_line_suspension', arguments: { numberId: NUMBER_ID, action: 'suspend', reason: 'Lost phone' } });
    await mcp.callTool({ name: 'telgea_set_line_suspension', arguments: { numberId: NUMBER_ID, action: 'restore', reason: 'Found it' } });
    expect(seen.map(r => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      `POST /v1/numbers/${NUMBER_ID}/suspension`,
      `DELETE /v1/numbers/${NUMBER_ID}/suspension`,
    ]);
  });

  it('runs prepare → commit through the tools, bound to the gateway user', async () => {
    process.env.TELGEA_ENABLE_WRITES = 'true';
    const { client, seen } = fakeTelgea(request => (request.method === 'GET' ? PLAN : { numberId: NUMBER_ID, state: 'PENDING' }));
    const alice = await connect(client, 'Alice@Example.com');
    const prepared = await alice.callTool({
      name: 'telgea_prepare_change',
      arguments: { kind: 'add_line', userId: USER_ID, countryCode: 'dk', reason: 'Second line' },
    });
    const { operation } = JSON.parse(text(prepared));
    expect(seen.filter(r => r.method !== 'GET')).toHaveLength(0);

    const mallory = await connect(client, 'mallory@example.com');
    const stolen = await mallory.callTool({
      name: 'telgea_commit_prepared_operation',
      arguments: { operation, confirmOperationHash: operation.operationHash },
    });
    expect(stolen.isError).toBe(true);

    const committed = await alice.callTool({
      name: 'telgea_commit_prepared_operation',
      arguments: { operation, confirmOperationHash: operation.operationHash },
    });
    expect(JSON.parse(text(committed)).status).toBe('applied');
    expect(seen.filter(r => r.method === 'POST')).toHaveLength(1);
  });

  it('enforces the 31-day usage window before calling Telgea', async () => {
    const { client, seen } = fakeTelgea(() => ({ items: [], hasMore: false }));
    const mcp = await connect(client);
    const result = await mcp.callTool({ name: 'telgea_list_usage', arguments: { startDate: '2026-01-01', endDate: '2026-03-01' } });
    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it('pages only as far as asked', async () => {
    const { client, seen } = fakeTelgea(request => {
      const page = Number(new URL(request.url).searchParams.get('page'));
      return { page, pageSize: 2, itemsCount: 5, items: [{ id: `${page}a` }, { id: `${page}b` }] };
    });
    const mcp = await connect(client);
    const one = JSON.parse(text(await mcp.callTool({ name: 'telgea_list_users', arguments: {} })));
    expect(one).toMatchObject({ nextPage: 2, itemsCount: 5 });
    const all = JSON.parse(text(await mcp.callTool({ name: 'telgea_list_users', arguments: { maxPages: 10 } })));
    expect(all.items).toHaveLength(6);
    expect(all.nextPage).toBeUndefined();
    expect(seen).toHaveLength(4);
  });
});
