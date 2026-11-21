# mcp-server-telgea

MCP server for the [Telgea](https://telgea.com) Open API ([reference](https://developer.telgea.com), [OpenAPI spec](https://api.telgea.com/openapi.json)), a business mobile operator with eSIM-based plans. It covers users and teams, user plans, lines and eSIMs, live connection status, number port-ins, usage records and analytics, data pools, rates and cost thresholds.

This is an independent, unofficial project. It is not developed, endorsed or supported by Telgea.

## Tools

| Tier | Tools |
|---|---|
| **Read** (always on) | `telgea_search_capabilities`, `telgea_server_status`, `telgea_list_users`, `telgea_list_teams`, `telgea_list_user_plans`, `telgea_find_user_plan` (by email, number or ICCID), `telgea_get_user_plan`, `telgea_list_lines`, `telgea_get_line`, `telgea_get_line_connection`, `telgea_get_port_in_requirements`, `telgea_validate_port_in`, `telgea_get_port_in`, `telgea_list_port_ins_for_line`, `telgea_list_usage`, `telgea_get_usage_analytics`, `telgea_list_data_pools`, `telgea_list_data_pool_members`, `telgea_list_rates`, `telgea_list_cost_thresholds`, `telgea_get_user_cost_threshold` |
| **Write** (`TELGEA_ENABLE_WRITES=true`) | `telgea_create_user`, `telgea_update_user`, `telgea_create_team`, `telgea_update_team`, `telgea_set_cost_threshold`, `telgea_remove_cost_threshold`, `telgea_set_line_suspension`, `telgea_set_data_restriction` |
| **Two-step** (`TELGEA_ENABLE_WRITES=true`) | `telgea_prepare_change` → `telgea_commit_prepared_operation`, for `create_user_plan`, `add_line`, `replace_sim`, `terminate_line`, `terminate_plan`, `delete_user`, `submit_port_in`, `discard_port_in` |
| **SIM secrets** (`TELGEA_ENABLE_SIM_SECRETS=true`) | `telgea_get_sim_credentials` |

## Guarantees

- **eSIM credentials are redacted everywhere else.** Telgea returns the eSIM activation code and PIN/PUK on every line and plan read, and whoever holds the activation code can install the line on their own phone. Every tool except `telgea_get_sim_credentials` replaces those fields, but keeps the ICCID. That one tool has its own switch and requires a `reason`, so a gateway can also gate it with a separate group.
- **Changes that cost money or cannot be undone take two steps.** These are new plans and lines, SIM swaps, port-ins, terminations and user deletion.
  - **Prepare** reads the target and returns an HMAC-signed preview with warnings. Nothing is sent.
  - **Commit** accepts only an unaltered operation that this server signed. It must arrive within 15 minutes and come from the user who prepared it, and its step must still pass the endpoint allowlist.
  - **Commit is safe to repeat.** The `Idempotency-Key` is derived from the operation hash, so committing twice makes Telgea replay its first answer instead of ordering a second line.
  - **Port-ins are checked first.** Telgea validates them during prepare, and invalid data stops the operation there.
- **The daily budget is protected.** Telgea allows **1000 requests per key per 24 hours** across every endpoint.
  - The server counts its own requests in a rolling window and refuses locally once `TELGEA_DAILY_REQUEST_BUDGET` is reached. `TELGEA_BUDGET_STATE` keeps the count across restarts.
  - Lists fetch one page unless `maxPages` asks for more, and reads are cached briefly (`TELGEA_CACHE_TTL_MS`). `telgea_server_status` shows what is left.
- **Writes need `TELGEA_ENABLE_WRITES=true`.** The tool policy checks this, and so does every write path.
- **Attribution goes in the audit log.** Telgea records every change against the API key. The JSONL audit (`TELGEA_AUDIT_LOG`) records:
  - the gateway-verified user (`X-MCP-User`) and the tool;
  - a SHA-256 hash of the identifiers, never the values;
  - the operation hash, for commits.
- **Forwarded identity requires the bearer token.**
  - The HTTP transport refuses to start when `TELGEA_TRUST_FORWARDED_USER=true` but no `MCP_HTTP_TOKEN` is set.
  - With trust on, it refuses requests that lack `X-MCP-User`.
  - The token is compared in constant time.
- **Ids cannot redirect requests.** An id with a separator, a dot segment, a query or percent-encoding is rejected before it reaches a URL. The client only calls `/v1/…` and sends the key only over HTTPS (or to loopback, for mocks).

## Telgea facts this server relies on

- Auth is the `x-api-key` header. Keys are organisation-scoped, and each endpoint needs its own permission (for example `numbers:suspend` or `orders:cancel`), so a key can be limited to the tiers you enable.
- Errors are RFC 9457 `application/problem+json`. The server surfaces `code`, `detail`, `fields` and `requestId`, and the `requestId` is what Telgea support asks for.
- `Idempotency-Key` is remembered for 24 hours per endpoint and replays the original outcome, including a failure.
- `/v1/usage` takes a window of at most 31 days and uses a cursor. The other lists are page-numbered, with `pageSize` at most 50 for users, teams and user plans and at most 100 for lines and port-ins. The spec says 100 for user plans, but the live API answers 400 above 50.
- Plans are addressed by their **user id**, and lines by their **number id**. A plan has a local and a travel number.

## Configuration

See [`.env.example`](.env.example). A production setup behind a gateway typically sets:

```
TELGEA_API_KEY=…
TELGEA_ENABLE_WRITES=true          # or false for a read-only endpoint
TELGEA_ENABLE_SIM_SECRETS=false
TELGEA_TRUST_FORWARDED_USER=true
TELGEA_AUDIT_LOG=/data/audit.jsonl
TELGEA_BUDGET_STATE=/data/budget.json
TELGEA_OPERATION_SECRET=…          # openssl rand -hex 32
MCP_HTTP_TOKEN=…                   # shared with the gateway; openssl rand -hex 32
```

`TELGEA_DAILY_REQUEST_BUDGET` (at least 1), `TELGEA_CACHE_TTL_MS` (0-86400000, 0 disables the cache) and `TELGEA_TIMEOUT_MS` (1-600000) must be plain integers; an invalid or out-of-range value stops the server at startup instead of silently disabling the limit.

### HTTP transport

| Variable | Default | Meaning |
|---|---|---|
| `MCP_HTTP_HOST` / `HOST` | `127.0.0.1` | Bind address. |
| `PORT` | `3000` | Listen port. |
| `MCP_HTTP_TOKEN` | – | Bearer token required on `/mcp`. At least 32 printable ASCII characters, e.g. `openssl rand -hex 32`. Required for any non-loopback bind and with `MCP_ALLOW_ANY_ORIGIN=true`. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Serve a non-loopback bind without a token (only when access is restricted by other means). |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated exact `Origin` values allowed. Requests without `Origin` (server-to-server) are allowed. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow every origin (requires `MCP_HTTP_TOKEN`). |
| `MCP_ALLOWED_HOSTS` | – | Comma-separated host names accepted in the `Host` header. Without it, a loopback bind only accepts localhost names and no check is done on other binds. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body. |
| `MCP_AUTH_FAILURE_LIMIT` | `20` | Failed authentication attempts per client address and window before further failures get 429; `0` disables. Valid tokens are never throttled. |
| `MCP_AUTH_FAILURE_WINDOW_MS` | `60000` | Window for the limit above. |

`GET /healthz` answers `{"status":"ok"}` without authentication. 401 responses carry
`WWW-Authenticate: Bearer`; invalid JSON gets 400. The server shuts down gracefully on SIGTERM/SIGINT.

`TELGEA_TRUST_FORWARDED_USER=true` always requires `MCP_HTTP_TOKEN`, also with `MCP_HTTP_ALLOW_UNAUTHENTICATED=true`.

## Deployment

The server runs as one container behind an authenticating MCP gateway that forwards the verified user as `X-MCP-User`. A typical access model:

| Who | Gateway rule |
|---|---|
| IT / telecom admins | the endpoint itself |
| who may commit two-step changes | duty group on `telgea_commit_prepared_operation` |
| who may see eSIM activation codes | duty group on `telgea_get_sim_credentials` (and `TELGEA_ENABLE_SIM_SECRETS=true`) |

## Security model

- The server calls Telgea with one shared, organisation-scoped API key. Every caller acts with that key's permissions; the forwarded user (`X-MCP-User`) is recorded in the audit log and bound to prepared operations, but Telgea itself only sees the key.
- Per-user authorization belongs in an identity-aware gateway in front of this server. `MCP_HTTP_TOKEN` only authenticates that gateway; it must strip `X-MCP-User` from client traffic and set it itself.
- Tool access is not data access: the switches and gateway rules limit which tools can be called, not what the API key can read.
- The HTTP server does not terminate TLS. Run it on a private network or behind a TLS-terminating proxy.
- Upstream redirects are never followed, so `x-api-key` is only sent to `TELGEA_BASE_URL`. Error bodies are read up to 64 KB, the key is redacted before error text is truncated, and error URLs omit query strings.

## Embedding (`./gateway`)

`mcp-server-telgea/gateway` is an embeddable entry point in the shape of `mcp-server-template`, for a host (such as an MCP gateway that does its own per-user authorization) that runs one instance per organisation:

```ts
import { createTelgeaGateway, telgeaToolCatalog } from 'mcp-server-telgea/gateway';

const gateway = createTelgeaGateway({
  apiKey,                       // the organisation's Telgea API key; required, never read from the environment
  timeoutMs: 30_000,            // optional, per request
  policy: { enableWrites: true, disabledTools: [], audit: record => log(record) },
});
gateway.tools;                                                  // tools enabled on this instance
await gateway.callTool('list_lines', { state: 'SUSPENDED' }, { caller: 'user-17' });
```

- **Only what the host gives.** The key comes from the host; the instance reads no `TELGEA_*` variable (key, base URL, timeout, cache, request budget, tier switches, audit log). It talks to `https://api.telgea.com` only, never follows a redirect and keeps no cache between calls.
- **Host policy.** `enableWrites` (default false), `disabledTools` (must name gateway tools) and `audit` (a sink that receives every audit record; without it none are written). A tool runs only after its start record was accepted. The caller is written as an HMAC pseudonym, the target as a hash and an error as a fixed code (`http_<status>`, `timeout`, `error`).
- **Our own words.** An HTTP error starts `Telgea API request failed with HTTP <status> (<method>).` with our hint and `retry-after`; Telgea's body is never read. An answer that is not JSON is refused.
- **Failure metadata.** When Telgea answered with an HTTP error or a redirect (which is not followed), the error result also has `failure: { httpStatus, requestId? }`: the status, and Telgea's request id from a response header (`REQUEST_ID_HEADERS` in `src/errors.ts`; never from the body) only when it is a hex id of 8 to 64 characters (one run of hex digits, or groups of four or more joined by single hyphens, as in a UUID) and does not hold the shape of a personal number. It is checked again after redaction. A host can count failures from it without reading their text. Never the response body, Telgea's error code or message.
- **Key admission and the sink check.** A key must be printable ASCII of at least 16 characters and share no 6-character piece with this package's own texts. Every result, error and audit record is redacted and checked in its final form; one that still holds a piece of the key is replaced by a fixed text.
- **Catalog.** `telgeaToolCatalog` (deeply frozen) lists every tool with its definition, the Telgea requests it may make (`upstream`) and `broad` (false for all).

### Gateway tools

| Kind | Tools |
| --- | --- |
| Read (enabled by default) | `search_capabilities`, `check_connection`, `list_users`, `list_teams`, `list_user_plans`, `get_user_plan` (by userId, email or phone number), `list_lines`, `get_line`, `get_usage_analytics`, `list_data_pools`, `list_data_pool_members`, `list_rates`, `list_cost_thresholds`, `get_user_cost_threshold` |
| Write (off by default) | `set_cost_threshold`, `set_data_restriction` (restrict or restore), `set_line_suspension` (suspend or restore) |

Every answer is projected onto an allowlist of fields. Never returned: the SIM of a line (ICCID, eSIM activation code, PIN, PUK) or its previous SIMs. Not in the gateway at all: SIM credentials, number port-ins, raw usage records (single calls and messages), live network data (IMEI, serving network), ordering, terminating or swapping plans, lines and SIMs, creating or changing users and teams, and removing a cost threshold. Nothing deletes; each change can be undone with the same tool.

## Install

```bash
npx mcp-server-telgea
```

Runs the stdio server from npm. Configure it with the environment variables in `.env.example`.

## Run

```bash
npm install
npm run dev          # stdio
npm run dev:http     # streamable HTTP on 127.0.0.1:3000/mcp (stateless)
npm test
TELGEA_API_KEY=… npm run smoke:live   # read-only, about 10 requests, prints shapes and counts only
```

Docker images: `ghcr.io/borgels/mcp-server-telgea` (published on push to `main`).
