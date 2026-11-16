import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TelgeaClient, type TelgeaClientOptions } from './telgea/client.js';
import { registerTelgeaTools } from './tools/telgea.js';
import { PACKAGE_VERSION } from './version.js';

export interface CreateServerOptions {
  client?: TelgeaClient;
  clientOptions?: TelgeaClientOptions;
  /** Verified user the request acts for (X-MCP-User from an authenticating proxy). */
  onBehalfOf?: string;
}

let sharedClient: TelgeaClient | undefined;

/**
 * The HTTP transport builds one McpServer per request, but the request
 * budget and read cache must span requests, so they share one client.
 */
export function defaultClient(): TelgeaClient {
  sharedClient ??= new TelgeaClient();
  return sharedClient;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'telgea',
    version: PACKAGE_VERSION,
  });

  const client = options.client ?? (options.clientOptions ? new TelgeaClient(options.clientOptions) : defaultClient());
  registerTelgeaTools(server, client, { actingAs: options.onBehalfOf });

  return server;
}
