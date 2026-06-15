import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillContext } from "@miniclaw/core";
import { applyHunks, parseUnifiedDiff } from "../src/lib/patch.ts";
import { applyPatchSkill } from "../skills/filesystem/handler.ts";

function makeCtx(root: string | undefined): SkillContext {
  return {
    memory: { add: () => 0, search: () => [], listRecent: () => [] },
    audit: { logToolCall: () => {} },
    dbPath: "/dev/null",
    workspaceRoot: root,
  };
}

describe("parseUnifiedDiff", () => {
  it("parses a single hunk with header lines preceding it", () => {
    const diff = [
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1,3 +1,3 @@",
      " line1",
      "-line2",
      "+LINE2",
      " line3",
      "",
    ].join("\n");
    const r = parseUnifiedDiff(diff);
    expect("hunks" in r).toBe(true);
    if ("hunks" in r) {
      expect(r.hunks).toHaveLength(1);
      const h = r.hunks[0]!;
      expect(h.oldStart).toBe(1);
      expect(h.oldLines).toBe(3);
      expect(h.lines).toEqual([" line1", "-line2", "+LINE2", " line3"]);
    }
  });

  it("rejects diffs with no hunks", () => {
    const r = parseUnifiedDiff("--- a/x\n+++ b/x\n");
    expect("error" in r).toBe(true);
  });

  it("rejects malformed hunk headers", () => {
    const r = parseUnifiedDiff("@@ broken @@\n line\n");
    expect("error" in r).toBe(true);
  });
});

describe("applyHunks", () => {
  it("applies a simple substitution", () => {
    const src = "a\nb\nc\n";
    const hunks = [
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" a", "-b", "+B", " c"] },
    ];
    const r = applyHunks(src, hunks);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toBe("a\nB\nc\n");
  });

  it("applies pure insertion in the middle", () => {
    const src = "a\nb\nc\n";
    const hunks = [
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 2, lines: [" b", "+inserted"] },
    ];
    const r = applyHunks(src, hunks);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toBe("a\nb\ninserted\nc\n");
  });

  it("applies deletion only", () => {
    const src = "a\nb\nc\n";
    const hunks = [
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 2, lines: [" a", "-b", " c"] },
    ];
    const r = applyHunks(src, hunks);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toBe("a\nc\n");
  });

  it("fails on context mismatch", () => {
    const src = "a\nb\nc\n";
    const hunks = [
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" a", "-X", "+B", " c"] },
    ];
    const r = applyHunks(src, hunks);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/deletion mismatch/);
  });

  it("preserves absence of trailing newline", () => {
    const src = "a\nb";
    const hunks = [
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" a", "-b", "+B"] },
    ];
    const r = applyHunks(src, hunks);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toBe("a\nB");
  });
});

describe("applyPatchSkill", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "miniclaw-fs-patch-"));
    writeFileSync(join(root, "file.txt"), "alpha\nbeta\ngamma\n");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("declares requiresConfirmation: true", () => {
    expect(applyPatchSkill.requiresConfirmation).toBe(true);
  });

  it("applies a valid unified diff and writes atomically", async () => {
    const diff = [
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "",
    ].join("\n");
    const res = await applyPatchSkill.execute(
      { path: "file.txt", diff, dryRun: false },
      makeCtx(root),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/patched path=file\.txt hunks=1/);
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("alpha\nBETA\ngamma\n");
    // No tmp turds.
    expect(readdirSync(root).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("dry-run returns a preview and leaves the file untouched", async () => {
    const original = readFileSync(join(root, "file.txt"), "utf8");
    const diff = [
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "",
    ].join("\n");
    const res = await applyPatchSkill.execute(
      { path: "file.txt", diff, dryRun: true },
      makeCtx(root),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/dry-run path=file\.txt/);
    expect(res.output).toContain("BETA");
    expect(res.output).toMatch(/<tool_output>[\s\S]*<\/tool_output>/);
    // File unchanged.
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe(original);
  });

  it("rejects patches that don't match the file", async () => {
    const diff = [
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-wrong",
      "+BETA",
      " gamma",
      "",
    ].join("\n");
    const res = await applyPatchSkill.execute(
      { path: "file.txt", diff, dryRun: false },
      makeCtx(root),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/patch apply failed/);
    // File untouched.
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("alpha\nbeta\ngamma\n");
  });

  it("refuses to patch paths outside the workspace", async () => {
    const res = await applyPatchSkill.execute(
      { path: "../etc/passwd", diff: "@@ -1 +1 @@\n-a\n+b\n", dryRun: false },
      makeCtx(root),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/refused/);
  });

  it("refuses to patch a missing file", async () => {
    const res = await applyPatchSkill.execute(
      { path: "ghost.txt", diff: "@@ -1 +1 @@\n-a\n+b\n", dryRun: false },
      makeCtx(root),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/ENOENT/);
  });

  it("refuses to follow a symlink that escapes the workspace", async () => {
    const outside = mkdtempSync(join(tmpdir(), "miniclaw-fs-outside-patch-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "alpha\nbeta\ngamma\n");
      symlinkSync(outside, join(root, "esc"));
      const diff = [
        "@@ -1,3 +1,3 @@",
        " alpha",
        "-beta",
        "+PWNED",
        " gamma",
        "",
      ].join("\n");
      const res = await applyPatchSkill.execute(
        { path: "esc/secret.txt", diff, dryRun: false },
        makeCtx(root),
      );
      expect(res.ok).toBe(false);
      expect(res.output).toMatch(/refused/);
      expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("alpha\nbeta\ngamma\n");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
