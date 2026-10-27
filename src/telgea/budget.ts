import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface BudgetStatus {
  limit: number;
  used: number;
  remaining: number;
  windowHours: number;
  oldestRequestAt?: string;
  persisted: boolean;
  note: string;
}

/**
 * Telgea allows each API key 1000 requests per 24 hours across every
 * endpoint and answers 429 beyond that. This counts the requests *this
 * server* makes in a rolling 24-hour window and refuses locally once the
 * configured limit is reached, so one runaway conversation cannot spend the
 * whole day's budget for everybody sharing the key.
 *
 * It cannot see requests other integrations make with the same key, so set
 * TELGEA_DAILY_REQUEST_BUDGET below 1000 when the key is shared. With
 * TELGEA_BUDGET_STATE the window survives restarts.
 */
export class RequestBudget {
  private timestamps: number[] = [];

  constructor(
    readonly limit: number,
    private readonly statePath?: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error('TELGEA_DAILY_REQUEST_BUDGET must be a positive number.');
    }
    this.load();
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): RequestBudget {
    return new RequestBudget(
      Number(env.TELGEA_DAILY_REQUEST_BUDGET ?? 1000),
      env.TELGEA_BUDGET_STATE || undefined,
    );
  }

  consume(): void {
    this.prune();
    if (this.timestamps.length >= this.limit) {
      const resetAt = new Date((this.timestamps[0] ?? this.now()) + WINDOW_MS).toISOString();
      throw new Error(
        `Telgea request budget exhausted: ${this.timestamps.length}/${this.limit} requests in the last 24 hours ` +
          `(the API allows 1000 per key per day). The next request is possible after ${resetAt}.`,
      );
    }
    this.timestamps.push(this.now());
    this.save();
  }

  status(): BudgetStatus {
    this.prune();
    const oldest = this.timestamps[0];
    return {
      limit: this.limit,
      used: this.timestamps.length,
      remaining: Math.max(0, this.limit - this.timestamps.length),
      windowHours: 24,
      oldestRequestAt: oldest === undefined ? undefined : new Date(oldest).toISOString(),
      persisted: Boolean(this.statePath),
      note: 'Counts only requests made by this server; other integrations using the same API key share the 1000/day Telgea limit.',
    };
  }

  private prune(): void {
    const cutoff = this.now() - WINDOW_MS;
    let drop = 0;
    while (drop < this.timestamps.length && (this.timestamps[drop] ?? 0) <= cutoff) {
      drop += 1;
    }
    if (drop) {
      this.timestamps = this.timestamps.slice(drop);
    }
  }

  private load(): void {
    if (!this.statePath) return;
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as unknown;
      if (Array.isArray(parsed)) {
        this.timestamps = parsed.filter((value): value is number => typeof value === 'number').sort((a, b) => a - b);
      }
    } catch {
      // Missing or unreadable state starts an empty window.
    }
    this.prune();
  }

  private save(): void {
    if (!this.statePath) return;
    const temp = `${this.statePath}.tmp`;
    writeFileSync(temp, JSON.stringify(this.timestamps), 'utf8');
    renameSync(temp, this.statePath);
  }
}
