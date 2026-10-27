/**
 * Three independent switches, mirroring the sibling MCP servers: the
 * container env decides what the server will ever do, and the gateway's
 * group/duty model decides who may call which tool.
 *
 * - TELGEA_ENABLE_WRITES: users, teams, cost thresholds, suspension and data
 *   restriction directly; and the two-step prepare/commit for what costs
 *   money or cannot be undone (new plans and lines, SIM swaps, port-ins,
 *   terminations, deleting users).
 * - TELGEA_ENABLE_SIM_SECRETS: telgea_get_sim_credentials, the one tool that
 *   returns eSIM activation codes and PIN/PUK. Every other tool redacts them.
 */
export function writesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TELGEA_ENABLE_WRITES === 'true';
}

export function simSecretsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TELGEA_ENABLE_SIM_SECRETS === 'true';
}

export function assertWritesEnabled(action: string): void {
  if (!writesEnabled()) {
    throw new Error(
      `Write access is disabled on this Telgea MCP instance (${action}). ` +
        'Set TELGEA_ENABLE_WRITES=true in the server environment to allow write tools.',
    );
  }
}

export interface TelgeaPolicyDecision {
  allowed: boolean;
  reason: string;
}

export const READ_TOOLS = new Set([
  'telgea_search_capabilities',
  'telgea_server_status',
  'telgea_list_users',
  'telgea_get_user_cost_threshold',
  'telgea_list_teams',
  'telgea_list_user_plans',
  'telgea_find_user_plan',
  'telgea_get_user_plan',
  'telgea_list_lines',
  'telgea_get_line',
  'telgea_get_line_connection',
  'telgea_get_port_in_requirements',
  'telgea_validate_port_in',
  'telgea_get_port_in',
  'telgea_list_port_ins_for_line',
  'telgea_list_usage',
  'telgea_get_usage_analytics',
  'telgea_list_data_pools',
  'telgea_list_data_pool_members',
  'telgea_list_rates',
  'telgea_list_cost_thresholds',
]);

export const WRITE_TOOLS = new Set([
  'telgea_create_user',
  'telgea_update_user',
  'telgea_create_team',
  'telgea_update_team',
  'telgea_set_cost_threshold',
  'telgea_remove_cost_threshold',
  'telgea_set_line_suspension',
  'telgea_set_data_restriction',
  'telgea_prepare_change',
  'telgea_commit_prepared_operation',
]);

export const SIM_SECRET_TOOLS = new Set(['telgea_get_sim_credentials']);

export function checkToolPolicy(toolName: string, env: NodeJS.ProcessEnv = process.env): TelgeaPolicyDecision {
  if (READ_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'read-only Telgea tool' };
  }

  if (WRITE_TOOLS.has(toolName)) {
    if (!writesEnabled(env)) {
      return {
        allowed: false,
        reason: `write tool is disabled on this instance (TELGEA_ENABLE_WRITES != true): ${toolName}`,
      };
    }
    return { allowed: true, reason: 'write tool (writes enabled on this instance)' };
  }

  if (SIM_SECRET_TOOLS.has(toolName)) {
    if (!simSecretsEnabled(env)) {
      return {
        allowed: false,
        reason: `SIM credential tool is disabled on this instance (TELGEA_ENABLE_SIM_SECRETS != true): ${toolName}`,
      };
    }
    return { allowed: true, reason: 'SIM credential tool (enabled on this instance)' };
  }

  return { allowed: false, reason: `tool is not allowlisted: ${toolName}` };
}
