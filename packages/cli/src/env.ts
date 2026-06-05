// Side-effect-only module: find and load .env *before* anything reads
// process.env. Importing this at the top of main.ts replaces the bare
// `import "dotenv/config"` that only looks in cwd.
//
// Two quirks this module handles:
//
//   1. cwd. `pnpm dev` runs the CLI with cwd set to packages/cli/, so
//      dotenv's default lookup never finds the repo-root .env. We walk
//      up from cwd / INIT_CWD / the source file's directory until we
//      hit one.
//
//   2. Empty shell exports. If your shell has `export ANTHROPIC_API_KEY=`
//      somewhere (an empty assignment), dotenv's default behavior is to
//      treat it as "already set" and skip overwriting it — even though
//      the value is empty. We detect that case and let the .env win.
//      Non-empty shell exports still take precedence (that's the
//      escape hatch for prod overrides).

import { parse } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findEnvFile(): string | null {
  const starts = [
    // INIT_CWD is set by pnpm to the directory where the user *invoked*
    // the command (vs cwd, which pnpm rewrites to the workspace dir).
    // Honor it so `pnpm dev` from the repo root finds the repo-root .env.
    process.env.INIT_CWD,
    process.cwd(),
    dirname(fileURLToPath(import.meta.url)),
  ].filter((s): s is string => typeof s === "string" && s.length > 0);

  for (const start of starts) {
    let dir = resolve(start);
    while (true) {
      const candidate = join(dir, ".env");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

const envPath = findEnvFile();
if (envPath) {
  const parsed = parse(readFileSync(envPath, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    // Override iff the current value is missing or empty/whitespace-only.
    // A real shell export with a real value still wins.
    const current = process.env[k];
    if (current === undefined || current.trim().length === 0) {
      process.env[k] = v;
    }
  }
}
