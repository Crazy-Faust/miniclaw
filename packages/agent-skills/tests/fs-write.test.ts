import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillContext } from "@miniclaw/core";
import { MAX_WRITE_BYTES, writeFileSkill } from "../skills/filesystem/handler.ts";

function makeCtx(root: string | undefined): SkillContext {
  return {
    memory: { add: () => 0, search: () => [], listRecent: () => [] },
    audit: { logToolCall: () => {} },
    dbPath: "/dev/null",
    workspaceRoot: root,
  };
}

describe("writeFileSkill", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "miniclaw-fs-write-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("declares requiresConfirmation: true (destructive op)", () => {
    expect(writeFileSkill.requiresConfirmation).toBe(true);
  });

  it("writes a new file inside the workspace", async () => {
    const res = await writeFileSkill.execute(
      { path: "hello.txt", content: "hi there\n", createDirs: false },
      makeCtx(root),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/wrote path=hello\.txt bytes=9/);
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("hi there\n");
  });

  it("overwrites an existing file atomically (no leftover .tmp files)", async () => {
    writeFileSync(join(root, "x.txt"), "old");
    const res = await writeFileSkill.execute(
      { path: "x.txt", content: "new content", createDirs: false },
      makeCtx(root),
    );
    expect(res.ok).toBe(true);
    expect(readFileSync(join(root, "x.txt"), "utf8")).toBe("new content");
    // No tmp turds left behind.
    const stragglers = readdirSync(root).filter((n) => n.includes(".tmp"));
    expect(stragglers).toEqual([]);
  });

  it("creates parent dirs when createDirs=true", async () => {
    const res = await writeFileSkill.execute(
      { path: "deep/nested/dir/file.txt", content: "ok", createDirs: true },
      makeCtx(root),
    );
    expect(res.ok).toBe(true);
    expect(readFileSync(join(root, "deep/nested/dir/file.txt"), "utf8")).toBe("ok");
  });

  it("fails when parent dir is missing and createDirs=false", async () => {
    const res = await writeFileSkill.execute(
      { path: "no/such/place.txt", content: "x", createDirs: false },
      makeCtx(root),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/ENOENT|refused/);
  });

  it("refuses content over the size cap", async () => {
    const big = "a".repeat(MAX_WRITE_BYTES + 1);
    const res = await writeFileSkill.execute(
      { path: "big.txt", content: big, createDirs: false },
      makeCtx(root),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/exceeds cap/);
    expect(existsSync(join(root, "big.txt"))).toBe(false);
  });

  it("refuses paths that climb out of the workspace", async () => {
    const res = await writeFileSkill.execute(
      { path: "../escape.txt", content: "x", createDirs: false },
      makeCtx(root),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/refused/);
  });

  it("refuses absolute paths outside the workspace", async () => {
    const res = await writeFileSkill.execute(
      { path: "/tmp/escape.txt", content: "x", createDirs: false },
      makeCtx(root),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/refused/);
  });

  it("refuses to operate when no workspaceRoot is configured", async () => {
    const res = await writeFileSkill.execute(
      { path: "x.txt", content: "x", createDirs: false },
      makeCtx(undefined),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/no workspace root/);
  });

  // The canonical symlink-escape test: create a symlink inside the workspace
  // pointing to a directory outside, then try to write a file *through* that
  // symlink and assert the write is refused and the target is untouched.
  it("refuses to follow a symlink that escapes the workspace", async () => {
    const outside = mkdtempSync(join(tmpdir(), "miniclaw-fs-outside-"));
    try {
      // Place a marker file in the outside dir so we can prove it's not touched.
      writeFileSync(join(outside, "marker.txt"), "do-not-overwrite");
      // Inside the workspace, "escape" is a symlink → outside dir.
      symlinkSync(outside, join(root, "escape"));

      // Attempt to overwrite the outside marker.txt via the symlinked parent.
      const res = await writeFileSkill.execute(
        { path: "escape/marker.txt", content: "PWNED", createDirs: false },
        makeCtx(root),
      );
      expect(res.ok).toBe(false);
      expect(res.output).toMatch(/refused/);
      // The outside file must be untouched.
      expect(readFileSync(join(outside, "marker.txt"), "utf8")).toBe("do-not-overwrite");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to create a new file under a symlinked-out parent", async () => {
    const outside = mkdtempSync(join(tmpdir(), "miniclaw-fs-outside2-"));
    try {
      symlinkSync(outside, join(root, "esc"));
      const res = await writeFileSkill.execute(
        { path: "esc/new.txt", content: "PWNED", createDirs: false },
        makeCtx(root),
      );
      expect(res.ok).toBe(false);
      expect(res.output).toMatch(/refused/);
      expect(existsSync(join(outside, "new.txt"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("writes are visible via stat after rename (atomic semantics)", async () => {
    const res = await writeFileSkill.execute(
      { path: "atomic.txt", content: "abc", createDirs: false },
      makeCtx(root),
    );
    expect(res.ok).toBe(true);
    expect(statSync(join(root, "atomic.txt")).size).toBe(3);
  });
});
