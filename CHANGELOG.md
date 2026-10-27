# Changelog

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
