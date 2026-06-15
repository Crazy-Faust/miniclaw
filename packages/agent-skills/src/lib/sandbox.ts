import { resolve, relative, isAbsolute } from "node:path";
import { realpathSync } from "node:fs";

export type SandboxCheckResult =
  | { ok: true; resolvedPath: string }
  | { ok: false; reason: string };

/**
 * Resolve `userPath` relative to `workspaceRoot` and confirm the result
 * still lives under `workspaceRoot`. Refuses absolute paths that escape,
 * relative paths with `..` segments that climb out, and symlinks pointing
 * outside the sandbox (best-effort: realpath only if the path exists).
 */
export function resolveInsideWorkspace(
  userPath: string,
  workspaceRoot: string,
): SandboxCheckResult {
  if (typeof userPath !== "string" || userPath.length === 0) {
    return { ok: false, reason: "path must be a non-empty string" };
  }
  if (userPath.includes("\0")) {
    return { ok: false, reason: "path contains a NUL byte" };
  }

  // Resolve the root *through any symlinks* once up front. macOS in
  // particular makes /var → /private/var, so a tmpdir-rooted workspace
  // would otherwise fail isUnder checks once the candidate is realpath'd.
  let absRoot: string;
  try {
    absRoot = realpathSync(resolve(workspaceRoot));
  } catch {
    absRoot = resolve(workspaceRoot);
  }

  const candidate = isAbsolute(userPath) ? resolve(userPath) : resolve(absRoot, userPath);

  // If the path exists, follow symlinks and check the real location.
  // Otherwise check the lexical resolution (so skills can surface ENOENT).
  try {
    const real = realpathSync(candidate);
    if (!isUnder(real, absRoot)) {
      return {
        ok: false,
        reason: `path '${userPath}' resolves (via symlink) outside the workspace root`,
      };
    }
    return { ok: true, resolvedPath: real };
  } catch {
    if (!isUnder(candidate, absRoot)) {
      return {
        ok: false,
        reason: `path '${userPath}' resolves outside the workspace root '${absRoot}'`,
      };
    }
    return { ok: true, resolvedPath: candidate };
  }
}

function isUnder(target: string, root: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
