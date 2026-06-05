// Cron job contract. A cron job is a stored prompt + cadence; the
// gateway's scheduler reads from this store on a tick and dispatches the
// prompt back into the agent loop.

export interface CronJobRecord {
  id: number;
  /** Human-readable label shown in cron_list. */
  name: string;
  /** Prompt text to send to the agent when the job fires. */
  prompt: string;
  /**
   * Cadence. Currently supports a tiny dialect:
   *   "@every 30s" | "@every 5m" | "@every 1h" | "@every 1d"
   * Future: real cron expressions.
   */
  schedule: string;
  /** ms since epoch — when the job was last fired. 0 if never. */
  lastRunAt: number;
  /** ms since epoch — next scheduled fire time. */
  nextRunAt: number;
  /** "active" or "paused". */
  status: string;
  createdAt: number;
}

export interface CronStore {
  addCron(name: string, prompt: string, schedule: string, nextRunAt: number): CronJobRecord;
  listCron(): CronJobRecord[];
  getCron(id: number): CronJobRecord | null;
  removeCron(id: number): void;
  /** Set status to "paused" (true) or "active" (false). */
  setCronPaused(id: number, paused: boolean): void;
  /** Stamp lastRunAt + nextRunAt after the gateway fires the job. */
  markCronRan(id: number, ranAt: number, nextRunAt: number): void;
  /** All active jobs whose nextRunAt is <= now, ordered by nextRunAt. */
  cronDueNow(now: number): CronJobRecord[];
}
