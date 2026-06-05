import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillContext } from "@miniclaw/core";
import { listDirectorySkill, readFileSkill } from "../src/index.ts";

function makeCtx(root: string | undefined): SkillContext {
  return {
    memory: { add: () => 0, search: () => [], listRecent: () => [] },
    audit: { logToolCall: () => {} },
    dbPath: "/dev/null",
    workspaceRoot: root,
  };
}

describe("readFileSkill", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "miniclaw-fs-read-"));
    writeFileSync(join(root, "hello.txt"), "hello world\n");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub/note.txt"), "nested content");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads a file inside the workspace", async () => {
    const res = await readFileSkill.execute({ path: "hello.txt" }, makeCtx(root));
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/path=hello\.txt bytes=12/);
    expect(res.output).toContain("hello world");
    expect(res.output).toMatch(/<tool_output>[\s\S]*<\/tool_output>/);
  });

  it("reads from a subdirectory", async () => {
    const res = await readFileSkill.execute({ path: "sub/note.txt" }, makeCtx(root));
    expect(res.ok).toBe(true);
    expect(res.output).toContain("nested content");
  });

  it("refuses paths that escape the workspace", async () => {
    const res = await readFileSkill.execute({ path: "../etc/passwd" }, makeCtx(root));
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/refused/);
  });

  it("refuses absolute paths outside the workspace", async () => {
    const res = await readFileSkill.execute({ path: "/etc/passwd" }, makeCtx(root));
    expect(res.ok).toBe(false);
  });

  it("surfaces ENOENT for a missing file", async () => {
    const res = await readFileSkill.execute({ path: "missing.txt" }, makeCtx(root));
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/ENOENT/);
  });

  it("refuses to operate when no workspaceRoot is configured", async () => {
    const res = await readFileSkill.execute({ path: "hello.txt" }, makeCtx(undefined));
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/no workspace root/);
  });

  it("truncates files larger than the byte cap", async () => {
    const big = "a".repeat(70 * 1024);
    writeFileSync(join(root, "big.txt"), big);
    const res = await readFileSkill.execute({ path: "big.txt" }, makeCtx(root));
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/\(truncated\)/);
  });
});

describe("listDirectorySkill", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "miniclaw-fs-ls-"));
    writeFileSync(join(root, "a.txt"), "1");
    writeFileSync(join(root, "b.txt"), "22");
    mkdirSync(join(root, "subdir"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists the workspace root when given '.'", async () => {
    const res = await listDirectorySkill.execute({ path: "." }, makeCtx(root));
    expect(res.ok).toBe(true);
    expect(res.output).toContain("a.txt");
    expect(res.output).toContain("b.txt");
    expect(res.output).toContain("subdir");
    // sizes present for files
    expect(res.output).toMatch(/"size": 1/);
    expect(res.output).toMatch(/"size": 2/);
  });

  it("marks directories with kind=directory", async () => {
    const res = await listDirectorySkill.execute({ path: "." }, makeCtx(root));
    expect(res.output).toMatch(/"name": "subdir"[\s\S]*?"kind": "directory"/);
  });

  it("refuses to escape the workspace", async () => {
    const res = await listDirectorySkill.execute({ path: ".." }, makeCtx(root));
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/refused/);
  });

  it("surfaces ENOENT for a missing directory", async () => {
    const res = await listDirectorySkill.execute({ path: "nope" }, makeCtx(root));
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/ENOENT/);
  });

  it("wraps the listing in <tool_output> as untrusted data", async () => {
    const res = await listDirectorySkill.execute({ path: "." }, makeCtx(root));
    expect(res.output).toMatch(/<tool_output>[\s\S]*<\/tool_output>/);
  });
});
