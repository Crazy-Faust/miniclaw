// Owned by skills-shell: anyone changing the shell skill must update this
// guard. Keeping it co-located makes the security contract auditable in one
// place.

import { isAbsolute, relative, resolve } from "node:path";

export const SHELL_ALLOWLIST: ReadonlySet<string> = new Set([
  "ls", "cat", "pwd", "echo", "git", "wc", "head", "tail", "grep", "find", "date", "uname", "whoami",
]);

export type ShellCheckResult =
  | { ok: true; bin: string; args: string[] }
  | { ok: false; reason: string };

export interface ShellCheckOpts {
  /**
   * When set, any arg that contains a path separator must resolve under
   * this directory. Args without separators (flags, simple words) pass
   * through untouched. Unset = no path sandboxing (legacy behavior).
   */
  workspaceRoot?: string;
  /**
   * Override the bin allowlist. Defaults to SHELL_ALLOWLIST. Tests use this
   * to admit fixtures (e.g. `node`) without touching the production set.
   */
  allowlist?: ReadonlySet<string>;
}

const FORBIDDEN_ARG_PATTERN = /[`$]|\$\(|\|\||&&/;

export function checkShellCall(
  bin: unknown,
  args: unknown,
  opts: ShellCheckOpts = {},
): ShellCheckResult {
  if (typeof bin !== "string" || bin.length === 0) {
    return { ok: false, reason: "bin must be a non-empty string" };
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(bin)) {
    return { ok: false, reason: `bin must be a bare command name, got: ${bin}` };
  }
  const allowlist = opts.allowlist ?? SHELL_ALLOWLIST;
  if (!allowlist.has(bin)) {
    return {
      ok: false,
      reason: `bin '${bin}' is not on the allowlist (${[...allowlist].join(", ")})`,
    };
  }
  if (!Array.isArray(args)) {
    return { ok: false, reason: "args must be an array of strings" };
  }
  const safeArgs: string[] = [];
  const root = opts.workspaceRoot ? resolve(opts.workspaceRoot) : null;
  for (const a of args) {
    if (typeof a !== "string") {
      return { ok: false, reason: "every arg must be a string" };
    }
    if (FORBIDDEN_ARG_PATTERN.test(a)) {
      return { ok: false, reason: `arg contains forbidden shell metacharacter: ${a}` };
    }
    // Path sandbox: anything that looks like a path (contains `/`) must
    // resolve inside the workspace root. Flags / single tokens pass through.
    if (root && a.includes("/")) {
      const candidate = isAbsolute(a) ? resolve(a) : resolve(root, a);
      const rel = relative(root, candidate);
      const escapes = rel.startsWith("..") || isAbsolute(rel);
      if (escapes) {
        return {
          ok: false,
          reason: `arg '${a}' resolves outside the workspace root '${root}'`,
        };
      }
    }
    safeArgs.push(a);
  }
  return { ok: true, bin, args: safeArgs };
}
