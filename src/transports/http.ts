import { ConfigError } from '../config-env.js';
import { defaultClient } from '../server.js';
import { configWarnings, getHttpConfig, type HttpConfig } from './http-helpers.js';
import { startHttpServer } from './http-server.js';

async function main(): Promise<void> {
  let config: HttpConfig;
  try {
    config = getHttpConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Telgea MCP HTTP server not started: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  try {
    // Validate the Telgea client configuration (base URL, timeout, request
    // budget, cache TTL) once at startup; the client is shared by all
    // requests.
    defaultClient();
  } catch (error) {
    console.error(`Telgea MCP HTTP server not started: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  for (const warning of configWarnings(config)) {
    console.error(warning);
  }

  const running = await startHttpServer(config);
  console.error(`Telgea MCP HTTP server listening on http://${config.host}:${running.port}/mcp`);

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down`);
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
