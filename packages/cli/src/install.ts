import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { launchdPlist, systemdUnit } from "@miniclaw/gateway";

import type { Config } from "./config.ts";

// Point the installed service file at the CLI's main entry (index.ts).
// Pointing at install.ts would just re-import the install module on every
// service start — `main()` lives in index.ts.
const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");

// Writes a launchd plist or systemd user unit to its conventional path
// — but never *loads* it. Loading requires `launchctl load` / `systemctl
// --user enable` and the user should opt in deliberately. Returns
// non-zero on any unexpected error.
export function runInstall(target: "launchd" | "systemd", config: Config): void {
  const tmpl = target === "launchd"
    ? launchdPlist(
        { exec: process.execPath, args: [ENTRY, "daemon", "run"], home: config.home, env: subsetEnv() },
        homedir(),
      )
    : systemdUnit(
        { exec: process.execPath, args: [ENTRY, "daemon", "run"], home: config.home, env: subsetEnv() },
        homedir(),
      );

  mkdirSync(dirname(tmpl.destPath), { recursive: true });
  writeFileSync(tmpl.destPath, tmpl.contents, "utf8");
  // VULN-02: Restrict service file permissions to owner-only (0600).
  // These files contain API keys in plaintext environment blocks.
  try { chmodSync(tmpl.destPath, 0o600); } catch { /* best-effort */ }
  process.stdout.write(tmpl.instructions + "\n");
}

// Only forward variables miniclaw cares about. Avoids leaking shell
// history, PATH overrides, etc., into the service environment.
function subsetEnv(): Record<string, string> {
  const keep = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "MINICLAW_PROVIDER",
    "MINICLAW_MODEL",
    "MINICLAW_BASE_URL",
    "MINICLAW_SMALL_PROVIDER",
    "MINICLAW_SMALL_MODEL",
    "MINICLAW_SMALL_API_KEY",
    "MINICLAW_SMALL_API_KEY_VAR",
    "MINICLAW_SMALL_BASE_URL",
    "MINICLAW_HOME",
    "MINICLAW_SOCKET",
    "MINICLAW_WORKSPACE",
    "MINICLAW_DISCORD_TOKEN",
  ];
  const out: Record<string, string> = {};
  for (const k of keep) {
    const v = process.env[k];
    if (v && v.length > 0) out[k] = v;
  }
  return out;
}
