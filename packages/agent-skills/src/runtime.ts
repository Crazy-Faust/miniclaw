// Runtime-bound bundled skills. Their tools need in-process objects (a Gateway,
// a CronStore) that only the CLI / daemon can build, so the CLI wires them from
// here rather than through the auto-discovered BUILTIN_HANDLERS map.
//
// Importing this entry pulls @miniclaw/gateway. The main barrel ("./index.ts")
// and the built-ins map deliberately do NOT import it, so packages that only
// need the loader + handler-backed built-ins stay gateway-free (and cycle-free).
// Their SKILL.md folders are still discovered for the catalog + use_skill; only
// the tool registration happens through these factories.
export { createCronSkills } from "../skills/cron/handler.ts";
export { createSessionsSkills } from "../skills/sessions/handler.ts";
