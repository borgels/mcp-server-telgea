/** eSIM fields that let someone install or unlock the SIM. */
export const SIM_SECRET_FIELDS = ['activationCode', 'pinOne', 'pinTwo', 'pukOne', 'pukTwo'] as const;

const REDACTED = '[redacted — telgea_get_sim_credentials]';

/**
 * Telgea returns eSIM activation codes and PIN/PUK on every line and plan
 * read. Anyone holding the activation code can install the line on their
 * own phone, so ordinary tools strip them; the ICCID stays (it identifies
 * the SIM and is what support asks for).
 */
export function redactSimSecrets<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(walk);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'sim' && child && typeof child === 'object' && !Array.isArray(child)) {
      out[key] = redactSim(child as Record<string, unknown>);
    } else {
      out[key] = walk(child);
    }
  }
  return out;
}

function redactSim(sim: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...sim };
  for (const field of SIM_SECRET_FIELDS) {
    if (out[field] !== undefined && out[field] !== null && out[field] !== '') {
      out[field] = REDACTED;
    }
  }
  return out;
}
