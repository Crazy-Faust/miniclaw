import { z } from "zod";
import { ok, fail, type CronStore, type Skill } from "@miniclaw/core";
import { firstFireFromNow, parseSchedule } from "@miniclaw/gateway";

/**
 * Build the four cron_* skills bound to a single CronStore. The
 * scheduler half (CronScheduler from @miniclaw/gateway) reads from the
 * same store on a tick to fire jobs.
 */
export function createCronSkills(store: CronStore): Skill<unknown>[] {
  const AddParams = z.object({
    name: z.string().min(1).max(80).describe("Short label shown by cron_list."),
    prompt: z
      .string()
      .min(1)
      .describe("Prompt sent to the agent each time the job fires."),
    schedule: z
      .string()
      .min(1)
      .describe('Cadence. Currently supports "@every Ns|Nm|Nh|Nd".'),
  });
  const add: Skill<z.infer<typeof AddParams>> = {
    name: "cron_add",
    description:
      "Schedule a recurring prompt to run on a cadence. Returns the new job id. " +
      'Cadence syntax: "@every 30s", "@every 5m", "@every 1h", "@every 1d".',
    parameters: AddParams,
    execute(args) {
      try {
        // Validate the schedule before persisting so a typo doesn't leave a
        // dead job in the store the scheduler can't run.
        parseSchedule(args.schedule);
      } catch (err) {
        return fail((err as Error).message);
      }
      const rec = store.addCron(args.name, args.prompt, args.schedule, firstFireFromNow(args.schedule));
      return ok(
        `scheduled job #${rec.id} (${rec.name}) — next fire ${new Date(rec.nextRunAt).toISOString()}`,
      );
    },
  };

  const list: Skill<Record<string, never>> = {
    name: "cron_list",
    description: "List all scheduled cron jobs (active + paused) with their next fire time.",
    parameters: z.object({}),
    execute() {
      const rows = store.listCron();
      if (rows.length === 0) return ok("(no cron jobs)");
      const lines = rows.map(
        (r) =>
          `#${r.id} [${r.status}] ${r.name} — schedule=${r.schedule}, next=${new Date(
            r.nextRunAt,
          ).toISOString()}, last=${
            r.lastRunAt > 0 ? new Date(r.lastRunAt).toISOString() : "(never)"
          }\n    prompt: ${r.prompt}`,
      );
      return ok(lines.join("\n"));
    },
  };

  const RemoveParams = z.object({ id: z.number().int().positive() });
  const remove: Skill<z.infer<typeof RemoveParams>> = {
    name: "cron_remove",
    description: "Delete a cron job by id. Does nothing if the id doesn't exist.",
    parameters: RemoveParams,
    execute(args) {
      const existed = store.getCron(args.id) !== null;
      store.removeCron(args.id);
      return ok(existed ? `removed cron job #${args.id}` : `(no job #${args.id})`);
    },
  };

  const PauseParams = z.object({
    id: z.number().int().positive(),
    paused: z.boolean().default(true),
  });
  const pause: Skill<z.infer<typeof PauseParams>> = {
    name: "cron_pause",
    description:
      "Pause (paused=true) or resume (paused=false) a cron job. Paused jobs " +
      "stay in the store but the scheduler skips them.",
    parameters: PauseParams,
    execute(args) {
      const job = store.getCron(args.id);
      if (!job) return fail(`unknown job: ${args.id}`);
      store.setCronPaused(args.id, args.paused);
      return ok(`job #${args.id} -> ${args.paused ? "paused" : "active"}`);
    },
  };

  return [add, list, remove, pause] as Skill<unknown>[];
}
