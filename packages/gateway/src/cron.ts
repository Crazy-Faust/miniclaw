import type { CronJobRecord, CronStore } from "@miniclaw/core";
import type { Gateway } from "./gateway.ts";

export interface CronSchedulerOpts {
  store: CronStore;
  gateway: Gateway;
  /**
   * Channel used to attach a session for jobs without a stored channel.
   * Jobs scheduled from Discord/CLI normally store their originating
   * channel so proactive results can return to the right transport.
   */
  channel?: string;
  /** Tick interval in ms. Default 30s. */
  tickMs?: number;
  /** Wall clock — injectable for tests. */
  now?: () => number;
  /**
   * Optional sink for proactive deliveries. The scheduler still runs the
   * prompt through the gateway/session; this hook lets transports send the
   * final text back to the originating channel.
   */
  onResult?: (job: CronJobRecord, channel: string, text: string) => Promise<void> | void;
}

/**
 * Polls the cron store on a tick. For every job whose nextRunAt is in the
 * past, fires the job against the gateway and bumps nextRunAt or removes
 * one-shot jobs. The
 * scheduler doesn't try to "catch up" — if the daemon was offline through
 * three fires of a 5-minute job, the job fires once on resume.
 */
export class CronScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight = false;

  constructor(private readonly opts: CronSchedulerOpts) {}

  start(): void {
    if (this.timer) return;
    const ms = this.opts.tickMs ?? 30_000;
    // Fire one immediate tick so jobs aren't held until the first interval.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), ms);
    // Don't keep the event loop alive on the timer alone — the socket
    // server has the real "stay up" reference.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Public for tests — fires one pass. */
  async tick(): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const now = (this.opts.now ?? Date.now)();
      const due = this.opts.store.cronDueNow(now);
      for (const job of due) {
        const channel = job.channel ?? this.opts.channel ?? "cron";
        const oneShot = isOneShotSchedule(job.schedule);
        if (oneShot) {
          // Remove BEFORE running so a crashing job doesn't re-fire forever.
          this.opts.store.removeCron(job.id);
        } else {
          const nextRunAt = nextFire(job.schedule, now);
          // Mark BEFORE running so a job that crashes the daemon doesn't
          // re-fire on every restart.
          this.opts.store.markCronRan(job.id, now, nextRunAt);
        }
        try {
          const session = this.opts.gateway.spawn(`cron:${job.id}:${now}`, "cron");
          try {
            const trace = await session.send(job.prompt);
            await this.opts.onResult?.(job, channel, trace.finalText);
          } finally {
            this.opts.gateway.end(session.record.id);
          }
        } catch (err) {
          // Cron failures are logged via the agent's audit log; swallow
          // here so one bad job doesn't take down the scheduler.
          // eslint-disable-next-line no-console
          console.error(`cron job #${job.id} failed:`, (err as Error).message);
        }
      }
    } finally {
      this.tickInFlight = false;
    }
  }
}

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a `@every N<unit>` cadence or `@once` and return the interval in
 * ms. Real cron expressions are intentionally deferred until a real user
 * asks for them.
 */
export function parseSchedule(schedule: string): number {
  if (isOneShotSchedule(schedule)) return 0;
  const m = /^@every\s+(\d+)\s*(s|m|h|d)$/i.exec(schedule.trim());
  if (!m) throw new Error(`unsupported schedule: ${schedule}. Use "@every N<s|m|h|d>" or "@once"`);
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  return n * UNIT_MS[unit]!;
}

export function isOneShotSchedule(schedule: string): boolean {
  return schedule.trim().toLowerCase() === "@once";
}

export function nextFire(schedule: string, from: number): number {
  return from + parseSchedule(schedule);
}

/** Re-exported for cron skill's add() to compute the initial nextRunAt. */
export function firstFireFromNow(schedule: string, now = Date.now()): number {
  return nextFire(schedule, now);
}

// Hack to keep TS happy that CronJobRecord is referenced at runtime. The
// gateway doesn't actually need the runtime type, but exporting one
// strongly-typed helper makes the public surface match the source-of-truth.
export type { CronJobRecord };
