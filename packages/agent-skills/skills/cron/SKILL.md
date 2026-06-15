---
name: cron
description: Schedule one-shot reminders and recurring prompts that run on a cadence. Use when the user says "remind me in/at ...", "every N minutes/hours/days do ...", or wants to list, remove, or pause scheduled jobs. Provides reminder_add and cron_add / cron_list / cron_remove / cron_pause.
license: MIT
compatibility: Scheduled jobs only fire while the miniclaw daemon is running (its CronScheduler ticks the store).
metadata:
  origin: miniclaw-builtin
---

# Cron & reminders

Schedule prompts to run later or on a repeating cadence. Jobs are persisted in
the store and fired by the daemon's `CronScheduler`; a job's result is delivered
to the channel that created it.

## Tools

- **`reminder_add`** — one-shot reminder. `delaySeconds` from now, optional
  `name`. Use for "remind me in 30s" / "remind me tomorrow to …".
- **`cron_add`** — recurring prompt. `schedule` cadence syntax: `@every 30s`,
  `@every 5m`, `@every 1h`, `@every 1d`. Returns the job id.
- **`cron_list`** — list all jobs (active + paused) with next/last fire times.
- **`cron_remove`** — delete a job by id.
- **`cron_pause`** — pause (`paused=true`) or resume (`paused=false`) a job.

## Notes

- Recurring jobs only actually fire while the **daemon** is running. In a plain
  one-shot REPL they are stored but won't tick.
- A bad cadence string is rejected by `cron_add` before anything is persisted.
