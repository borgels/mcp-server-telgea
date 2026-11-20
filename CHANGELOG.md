# Changelog

## Unreleased

- Published to npm and the MCP Registry from tagged releases.

## 0.3.0

- New package export `./gateway` in the shape of `mcp-server-template`: `createTelgeaGateway`, `telgeaGatewayTools` and the frozen `telgeaToolCatalog` (with `upstream` and `broad`). The key comes only from the host, no `TELGEA_*` variable is read, the address is fixed to `https://api.telgea.com`, redirects are never followed, and there is no cache or budget between calls.
- Host policy (writes, disabled tools, audit sink), a call scope per call, redaction per instance, key admission and the sink check.
- 14 narrow reads and 3 reversible changes (cost threshold, data restriction, line suspension). Answers are projected onto allowlisted fields: SIM data (ICCID, activation code, PIN, PUK) is never returned, and SIM credentials, port-ins, raw usage records, live network data, orders, terminations and deletions are not in the gateway.
- The MCP server's own tools are unchanged.

## 0.2.0

### Upgrade notes

- The HTTP server refuses to start on a non-loopback bind (`MCP_HTTP_HOST`/`HOST`
  other than 127.0.0.1/localhost/::1), or with `MCP_ALLOW_ANY_ORIGIN=true`, unless
  `MCP_HTTP_TOKEN` is set. `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` is an explicit
  escape hatch for networks restricted by other means.
- `MCP_HTTP_TOKEN` must be at least 32 printable ASCII characters
  (e.g. `openssl rand -hex 32`).
- `TELGEA_DAILY_REQUEST_BUDGET`, `TELGEA_CACHE_TTL_MS`, `TELGEA_TIMEOUT_MS`, `PORT`,
  `MCP_MAX_BODY_BYTES` and the boolean `MCP_*` flags are validated as integers /
  booleans; invalid values stop the server at startup. A blank
  `TELGEA_DAILY_REQUEST_BUDGET` now means the default (1000).
- Ranges: `TELGEA_DAILY_REQUEST_BUDGET` at least 1, `TELGEA_CACHE_TTL_MS` 0-86400000
  (24 hours), `TELGEA_TIMEOUT_MS` 1-600000 (10 minutes). A larger value that was
  previously accepted now stops the server at startup.
- The HTTP server validates the Telgea client configuration at startup.
- New optional variables: `MCP_HTTP_ALLOW_UNAUTHENTICATED`, `MCP_ALLOWED_HOSTS`,
  `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS`.

### Changes

- HTTP: 401 responses carry `WWW-Authenticate: Bearer`; invalid JSON gets 400
  (JSON-RPC parse error) instead of 500; oversized bodies get 413 before the body
  is read when `Content-Length` is too large.
- HTTP: failed authentication is counted per client address; after the limit
  further failures get 429 with `Retry-After`. Valid tokens are never throttled.
- HTTP: `Host` header check on loopback binds; `GET /healthz`; graceful shutdown
  on SIGTERM/SIGINT; one log line per rejected request.
- Telgea client: redirects are never followed, so `x-api-key` is only sent to
  `TELGEA_BASE_URL`. Error bodies are read up to 64 KB; the key is redacted by
  value before error text is truncated; query strings are not included in error
  URLs.
- The server reports the package version.
- Dependencies updated within their ranges; container images are published only
  after CI passes, with SBOM and provenance attestations.

## 0.1.0

Initial release.

- Read tools for users, teams, user plans, lines (numbers), live connection
  status, port-ins, usage records, usage analytics, data pools, rates and
  cost thresholds.
- Direct writes behind TELGEA_ENABLE_WRITES: users, teams, cost thresholds,
  line suspension and mobile-data restriction.
- Two-step prepare/commit for plans, lines, SIM replacement, port-ins,
  terminations and user deletion: HMAC-signed preview, 15-minute expiry,
  bound to the preparing user, allowlisted steps, and an Idempotency-Key
  derived from the operation hash so a repeated commit is replayed rather
  than executed twice. Port-ins are validated with Telgea at prepare.
- eSIM activation codes and PIN/PUK redacted from every read; only
  telgea_get_sim_credentials returns them, behind TELGEA_ENABLE_SIM_SECRETS.
- Rolling 24-hour request budget (Telgea allows 1000/key/day), optionally
  persisted; short GET cache cleared on writes; one retry on 503.
- JSONL audit with the gateway-verified user (X-MCP-User) and hashed targets.
- Stateless streamable HTTP transport with constant-time bearer auth, and
  refusal to start when forwarded identity is trusted without a token.
