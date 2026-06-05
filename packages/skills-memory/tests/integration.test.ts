import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillContext } from "@miniclaw/core";
import { SqliteStore } from "@miniclaw/memory-sqlite";
import { searchMemorySkill, writeMemorySkill } from "../src/index.ts";

// Integration: skills-memory paired with the real SQLite store, so FTS5
// retrieval gets exercised end-to-end through the skill surface.

describe("skills-memory ↔ memory-sqlite", () => {
  let dir: string;
  let store: SqliteStore;
  let ctx: SkillContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-skills-mem-int-"));
    store = new SqliteStore(join(dir, "test.db"));
    ctx = { memory: store, audit: store, dbPath: store.path };
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("write_memory persists into the SQLite-backed store", async () => {
    const res = await writeMemorySkill.execute(
      { content: "user lives in Berlin", kind: "fact", tags: ["bio"] },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(store.listRecent(10)).toHaveLength(1);
    expect(store.listRecent(10)[0]).toMatchObject({
      content: "user lives in Berlin",
      kind: "fact",
      tags: ["bio"],
    });
  });

  it("search_memory finds memories via FTS5 across multiple writes", async () => {
    await writeMemorySkill.execute(
      { content: "user prefers the helix editor", kind: "preference", tags: [] },
      ctx,
    );
    await writeMemorySkill.execute(
      { content: "user prefers oat milk in coffee", kind: "preference", tags: [] },
      ctx,
    );

    const helixHit = await searchMemorySkill.execute({ query: "helix", limit: 5 }, ctx);
    expect(helixHit.output).toContain("helix");
    expect(helixHit.output).not.toContain("oat milk");

    const milkHit = await searchMemorySkill.execute({ query: "milk", limit: 5 }, ctx);
    expect(milkHit.output).toContain("oat milk");
  });

  it("search_memory returns the 'no matches' message when FTS finds nothing relevant", async () => {
    await writeMemorySkill.execute(
      { content: "totally unrelated", kind: "note", tags: [] },
      ctx,
    );
    // 'xylophone' won't match 'totally unrelated' content under FTS.
    const res = await searchMemorySkill.execute({ query: "xylophone", limit: 5 }, ctx);
    expect(res.output).toBe("no matching memories");
  });

  it("write_memory + search_memory honor tags through the store", async () => {
    await writeMemorySkill.execute(
      { content: "uses Berlin tag", kind: "note", tags: ["berlin", "location"] },
      ctx,
    );
    const res = await searchMemorySkill.execute({ query: "Berlin", limit: 5 }, ctx);
    expect(res.output).toMatch(/berlin,location/);
  });
});
