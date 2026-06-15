import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInsideWorkspace } from "../src/lib/sandbox.ts";

describe("resolveInsideWorkspace", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "miniclaw-fs-sandbox-"));
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub/inside.txt"), "ok");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts a relative path that resolves inside the root", () => {
    const r = resolveInsideWorkspace("sub/inside.txt", root);
    expect(r.ok).toBe(true);
  });

  it("accepts an absolute path inside the root", () => {
    const r = resolveInsideWorkspace(join(root, "sub/inside.txt"), root);
    expect(r.ok).toBe(true);
  });

  it("refuses a relative path that climbs out with ..", () => {
    const r = resolveInsideWorkspace("../etc/passwd", root);
    expect(r.ok).toBe(false);
  });

  it("refuses an absolute path outside the root", () => {
    const r = resolveInsideWorkspace("/etc/passwd", root);
    expect(r.ok).toBe(false);
  });

  it("refuses an empty path", () => {
    const r = resolveInsideWorkspace("", root);
    expect(r.ok).toBe(false);
  });

  it("refuses paths containing a NUL byte", () => {
    const r = resolveInsideWorkspace("ok\0nope", root);
    expect(r.ok).toBe(false);
  });

  it("refuses a symlink that points outside the root", () => {
    const target = mkdtempSync(join(tmpdir(), "miniclaw-fs-outside-"));
    writeFileSync(join(target, "outside.txt"), "secret");
    symlinkSync(target, join(root, "escape"));

    const r = resolveInsideWorkspace("escape/outside.txt", root);
    expect(r.ok).toBe(false);

    rmSync(target, { recursive: true, force: true });
  });

  it("permits a non-existent path (so read_file can surface ENOENT cleanly)", () => {
    const r = resolveInsideWorkspace("does-not-exist.txt", root);
    expect(r.ok).toBe(true);
  });
});
