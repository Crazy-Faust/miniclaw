// Unified-diff parsing and application. Pure functions shared by the
// filesystem skill's apply_patch handler; kept here so they are reusable and
// independently testable.

export const MAX_PATCH_RESULT_BYTES = 256 * 1024;

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // lines starting with ' ', '-', '+', or '\\'
}

export function parseUnifiedDiff(diff: string): { hunks: Hunk[] } | { error: string } {
  const lines = diff.split(/\r?\n/);
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    // Skip file headers and any preamble.
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("diff ") || line.startsWith("index ")) {
      i++;
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m || m[1] === undefined || m[3] === undefined) {
        return { error: `malformed hunk header at line ${i + 1}: ${line}` };
      }
      const hunk: Hunk = {
        oldStart: parseInt(m[1], 10),
        oldLines: m[2] === undefined ? 1 : parseInt(m[2], 10),
        newStart: parseInt(m[3], 10),
        newLines: m[4] === undefined ? 1 : parseInt(m[4], 10),
        lines: [],
      };
      i++;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (l.startsWith("@@")) break;
        if (l.startsWith("--- ") || l.startsWith("+++ ") || l.startsWith("diff ")) break;
        // A trailing empty string from the final split is normal — only push
        // if it's a real diff line (starts with ' ', '-', '+', '\\') or is an
        // empty context line in the middle of the hunk.
        if (l === "" && i === lines.length - 1) {
          i++;
          continue;
        }
        const first = l.length === 0 ? "" : l[0];
        if (l.length === 0 || first === " " || first === "+" || first === "-" || first === "\\") {
          hunk.lines.push(l);
          i++;
        } else {
          // Non-diff line — end the hunk.
          break;
        }
      }
      hunks.push(hunk);
      continue;
    }
    // Anything else: skip silently (preamble between files, etc.).
    i++;
  }
  if (hunks.length === 0) return { error: "no hunks found in diff" };
  return { hunks };
}

export function applyHunks(source: string, hunks: Hunk[]): { ok: true; result: string } | { ok: false; error: string } {
  // Preserve trailing newline awareness.
  const sourceHadTrailingNL = source.endsWith("\n");
  const srcLines = sourceHadTrailingNL ? source.slice(0, -1).split("\n") : source.split("\n");

  // We rebuild the output by walking source lines and applying each hunk at
  // its declared oldStart. Lines outside hunks are copied verbatim.
  const out: string[] = [];
  let srcIdx = 0; // 0-based index into srcLines
  for (const h of hunks) {
    const hunkSrcStart = Math.max(0, h.oldStart - 1); // -1 for 0-based; an oldStart of 0 means empty file
    if (hunkSrcStart < srcIdx) {
      return { ok: false, error: `hunks out of order at @@ -${h.oldStart},${h.oldLines}` };
    }
    if (hunkSrcStart > srcLines.length) {
      return {
        ok: false,
        error: `hunk @@ -${h.oldStart},${h.oldLines} starts past end of file (file has ${srcLines.length} lines)`,
      };
    }
    // Copy unchanged lines between previous position and this hunk.
    while (srcIdx < hunkSrcStart) {
      out.push(srcLines[srcIdx] ?? "");
      srcIdx++;
    }
    // Apply hunk lines.
    for (const hl of h.lines) {
      if (hl.startsWith("\\")) continue; // "\ No newline at end of file" — ignore
      const tag = hl.length === 0 ? " " : hl[0];
      const content = hl.slice(1);
      if (tag === " ") {
        if (srcIdx >= srcLines.length) {
          return { ok: false, error: `context line past EOF in hunk @@ -${h.oldStart}` };
        }
        const cur = srcLines[srcIdx] ?? "";
        if (cur !== content) {
          return {
            ok: false,
            error: `context mismatch at source line ${srcIdx + 1}: expected ${JSON.stringify(content)}, got ${JSON.stringify(cur)}`,
          };
        }
        out.push(content);
        srcIdx++;
      } else if (tag === "-") {
        if (srcIdx >= srcLines.length) {
          return { ok: false, error: `deletion past EOF in hunk @@ -${h.oldStart}` };
        }
        const cur = srcLines[srcIdx] ?? "";
        if (cur !== content) {
          return {
            ok: false,
            error: `deletion mismatch at source line ${srcIdx + 1}: expected ${JSON.stringify(content)}, got ${JSON.stringify(cur)}`,
          };
        }
        srcIdx++;
      } else if (tag === "+") {
        out.push(content);
      } else {
        return { ok: false, error: `unrecognized diff line: ${JSON.stringify(hl)}` };
      }
    }
  }
  // Copy any trailing lines after the last hunk.
  while (srcIdx < srcLines.length) {
    out.push(srcLines[srcIdx] ?? "");
    srcIdx++;
  }

  let result = out.join("\n");
  if (sourceHadTrailingNL && result.length > 0) result += "\n";
  return { ok: true, result };
}

export function summarizeDiff(before: string, after: string, maxLines = 40): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const added = afterLines.length - beforeLines.length;
  // A tiny preview: first up-to-maxLines lines of the new file.
  const previewLines = afterLines.slice(0, maxLines);
  const truncated = afterLines.length > maxLines;
  return (
    `lines before=${beforeLines.length} after=${afterLines.length} delta=${added >= 0 ? "+" : ""}${added}\n` +
    `preview (first ${previewLines.length} lines${truncated ? ", truncated" : ""}):\n` +
    previewLines.join("\n")
  );
}
