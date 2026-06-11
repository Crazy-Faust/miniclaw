import { describe, expect, it } from "vitest";
import type { MemoryRecord, MemoryStore, SkillContext } from "@miniclaw/core";
import { searchMemorySkill, writeMemorySkill } from "../src/index.ts";

// Hand-rolled in-memory MemoryStore so the test asserts only what the skill
// itself owns (the call into the contract), not the SQLite impl.
class FakeMemoryStore implements MemoryStore {
  records: MemoryRecord[] = [];
  private seq = 0;

  add(kind: string, content: string, tags: string[] = [], opts: { folder?: string } = {}): number {
    const id = ++this.seq;
    this.records.push({ id, kind, content, tags, folder: opts.folder ?? "inbox", createdAt: Date.now() });
    return id;
  }
  search(query: string, limit = 5, opts: { folder?: string } = {}): MemoryRecord[] {
    const q = query.toLowerCase();
    return this.records
      .filter((r) => r.content.toLowerCase().includes(q))
      .filter((r) => !opts.folder || r.folder === opts.folder)
      .slice(0, limit);
  }
  listRecent(limit: number): MemoryRecord[] {
    return [...this.records].reverse().slice(0, limit);
  }
}

function makeCtx(memory: MemoryStore): SkillContext {
  return {
    memory,
    audit: { logToolCall: () => {} },
    dbPath: "/dev/null",
  };
}

describe("writeMemorySkill", () => {
  it("persists a memory through the MemoryStore", async () => {
    const mem = new FakeMemoryStore();
    const res = await writeMemorySkill.execute(
      { content: "user likes helix", kind: "preference", tags: ["editor"] },
      makeCtx(mem),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/stored memory #1/);
    expect(mem.records).toHaveLength(1);
    expect(mem.records[0]).toMatchObject({
      kind: "preference",
      content: "user likes helix",
      tags: ["editor"],
      folder: "inbox",
    });
  });

  it("passes an optional folder through to the MemoryStore", async () => {
    const mem = new FakeMemoryStore();
    const res = await writeMemorySkill.execute(
      { content: "paper note", kind: "note", tags: [], folder: "research/papers" },
      makeCtx(mem),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/folder=research\/papers/);
    expect(mem.records[0]).toMatchObject({ folder: "research/papers" });
  });

  it("rejects unsafe folder paths", async () => {
    const mem = new FakeMemoryStore();
    const res = await writeMemorySkill.execute(
      { content: "x", kind: "note", tags: [], folder: "../escape" },
      makeCtx(mem),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/invalid folder/);
  });

  it("includes tags in the confirmation message", async () => {
    const mem = new FakeMemoryStore();
    const res = await writeMemorySkill.execute(
      { content: "x", kind: "note", tags: ["a", "b"] },
      makeCtx(mem),
    );
    expect(res.output).toMatch(/tags=\[a, b\]/);
  });
});

describe("searchMemorySkill", () => {
  it("returns a formatted list of matching memories", async () => {
    const mem = new FakeMemoryStore();
    mem.add("fact", "user prefers helix editor", ["editor"]);
    mem.add("fact", "user prefers oat milk");

    const res = await searchMemorySkill.execute(
      { query: "helix", limit: 5 },
      makeCtx(mem),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/#1 \[fact folder=inbox status=active editor\] user prefers helix editor/);
    expect(res.output).not.toContain("oat milk");
  });

  it("can restrict search to a folder", async () => {
    const mem = new FakeMemoryStore();
    mem.add("fact", "alpha note", [], { folder: "research" });
    mem.add("fact", "alpha note", [], { folder: "personal" });

    const res = await searchMemorySkill.execute(
      { query: "alpha", limit: 5, folder: "personal" },
      makeCtx(mem),
    );

    expect(res.output).toContain("folder=personal");
    expect(res.output).not.toContain("folder=research");
  });

  it("returns a friendly message when nothing matches", async () => {
    const mem = new FakeMemoryStore();
    mem.add("fact", "unrelated content");
    const res = await searchMemorySkill.execute(
      { query: "nothing-matches", limit: 5 },
      makeCtx(mem),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toBe("no matching memories");
  });

  it("honors the limit", async () => {
    const mem = new FakeMemoryStore();
    for (let i = 0; i < 10; i++) mem.add("fact", `match item ${i}`);
    const res = await searchMemorySkill.execute(
      { query: "match", limit: 3 },
      makeCtx(mem),
    );
    expect(res.output.split("\n")).toHaveLength(3);
  });
});
