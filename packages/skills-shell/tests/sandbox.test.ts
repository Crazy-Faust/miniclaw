import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillContext } from "@miniclaw/core";
import { checkShellCall, shellSkill } from "../src/index.ts";

describe("checkShellCall with workspaceRoot", () => {
  it("accepts a relative path inside the workspace", () => {
    const r = checkShellCall("ls", ["sub/file"], { workspaceRoot: "/Users/x/ws" });
    expect(r.ok).toBe(true);
  });

  it("rejects an absolute path outside the workspace", () => {
    const r = checkShellCall("ls", ["/etc/passwd"], { workspaceRoot: "/Users/x/ws" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/outside the workspace root/);
  });

  it("rejects a relative path with .. that climbs out", () => {
    const r = checkShellCall("ls", ["../../etc"], { workspaceRoot: "/Users/x/ws" });
    expect(r.ok).toBe(false);
  });

  it("accepts an absolute path that IS under the workspace", () => {
    const r = checkShellCall("ls", ["/Users/x/ws/sub/file"], {
      workspaceRoot: "/Users/x/ws",
    });
    expect(r.ok).toBe(true);
  });

  it("passes flag-style args (no slash) through untouched", () => {
    const r = checkShellCall("ls", ["-la", "--color"], { workspaceRoot: "/Users/x/ws" });
    expect(r.ok).toBe(true);
  });

  it("falls back to no sandboxing when workspaceRoot is unset (back-compat)", () => {
    const r = checkShellCall("ls", ["/etc/passwd"]);
    expect(r.ok).toBe(true);
  });
});

describe("shellSkill with workspaceRoot (end-to-end spawn)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "miniclaw-shell-sandbox-"));
    writeFileSync(join(root, "hello.txt"), "hi");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub/inner.txt"), "deep");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function ctxWith(wsRoot: string | undefined): SkillContext {
    return {
      memory: { add: () => 0, search: () => [], listRecent: () => [] },
      audit: { logToolCall: () => {} },
      dbPath: "/dev/null",
      workspaceRoot: wsRoot,
    };
  }

  it("anchors child cwd to workspaceRoot (relative ls sees workspace files)", async () => {
    const res = await shellSkill.execute({ bin: "ls", args: [] }, ctxWith(root));
    expect(res.ok).toBe(true);
    expect(res.output).toContain("hello.txt");
    expect(res.output).toContain("sub");
  });

  it("refuses to ls an absolute path outside the workspace", async () => {
    const res = await shellSkill.execute({ bin: "ls", args: ["/etc"] }, ctxWith(root));
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/outside the workspace root/);
  });

  it("refuses to cat ../something via relative climb", async () => {
    const res = await shellSkill.execute(
      { bin: "cat", args: ["../../etc/passwd"] },
      ctxWith(root),
    );
    expect(res.ok).toBe(false);
  });

  it("permits cat-ing a file inside the workspace by absolute path", async () => {
    const res = await shellSkill.execute(
      { bin: "cat", args: [join(root, "hello.txt")] },
      ctxWith(root),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("hi");
  });
});
