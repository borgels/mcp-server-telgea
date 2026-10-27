# mcp-server-telgea

MCP server for the [Telgea](https://telgea.com) Open API ([reference](https://developer.telgea.com), [OpenAPI spec](https://api.telgea.com/openapi.json)), a business mobile operator with eSIM-based plans. It covers users and teams, user plans, lines and eSIMs, live connection status, number port-ins, usage records and analytics, data pools, rates and cost thresholds.

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
MCP_HTTP_TOKEN=…                   # shared with the gateway
```

## Deployment

The server runs as one container behind an authenticating MCP gateway that forwards the verified user as `X-MCP-User`. A typical access model:

| Who | Gateway rule |
|---|---|
| IT / telecom admins | the endpoint itself |
| who may commit two-step changes | duty group on `telgea_commit_prepared_operation` |
| who may see eSIM activation codes | duty group on `telgea_get_sim_credentials` (and `TELGEA_ENABLE_SIM_SECRETS=true`) |

## Run

```bash
npm install
npm run dev          # stdio
npm run dev:http     # streamable HTTP on 127.0.0.1:3000/mcp (stateless)
npm test
TELGEA_API_KEY=… npm run smoke:live   # read-only, about 10 requests, prints shapes and counts only
```

Docker images: `ghcr.io/borgels/mcp-server-telgea` (published on push to `main`).
