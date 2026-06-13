import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SqliteStore } from "../src/index.ts";

describe("SqliteStore", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-test-"));
    store = new SqliteStore(join(dir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds and retrieves recent memories", () => {
    const id1 = store.add("fact", "user prefers helix");
    const id2 = store.add("preference", "user prefers dark mode", ["ui"]);
    const recent = store.listRecent(10);
    expect(recent.map((r) => r.id)).toEqual([id2, id1]);
    expect(recent[0]!.tags).toEqual(["ui"]);
  });

  it("migrates existing memories into inbox metadata", () => {
    store.close();
    const dbPath = join(dir, "legacy.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      INSERT INTO memories(kind, content, tags, created_at)
      VALUES ('fact', 'legacy memory', '', 123);
    `);
    db.close();

    store = new SqliteStore(dbPath);

    expect(store.listRecent(1)[0]).toMatchObject({
      content: "legacy memory",
      folder: "inbox",
      status: "active",
    });
  });

  it("adds folder metadata and enqueues one maintenance job for memory writes", () => {
    const id = store.add("fact", "paper alpha", ["research"], { folder: "research/papers" });
    expect(store.listRecent(1)[0]).toMatchObject({
      id,
      folder: "research/papers",
      status: "active",
    });

    const jobs = store.pendingMemoryMaintenanceJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: "memory_write",
      memoryId: id,
      status: "pending",
    });
    expect(jobs[0]!.payload).toMatchObject({ folder: "research/papers", content: "paper alpha" });
  });

  it("rejects invalid memory folders", () => {
    expect(() => store.add("fact", "bad", [], { folder: "/absolute" })).toThrow(/relative/);
    expect(() => store.add("fact", "bad", [], { folder: "../escape" })).toThrow(/\.\./);
  });

  it("FTS5 search finds inserted content", () => {
    store.add("fact", "user prefers the helix editor");
    store.add("fact", "user prefers oat milk in coffee");
    const hits = store.search("helix");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toContain("helix");
  });

  it("search can be restricted by folder and skips retired memories", () => {
    const active = store.add("fact", "alpha in research", [], { folder: "research" });
    const other = store.add("fact", "alpha in personal", [], { folder: "personal" });
    store.updateMemoryMetadata(other, { status: "retired" });

    expect(store.search("alpha", 10).map((m) => m.id)).toEqual([active]);
    expect(store.search("alpha", 10, { folder: "personal" })).toEqual([]);
  });

  it("stores wiki pages and prefers them as long-term knowledge", () => {
    const id = store.add("fact", "alpha raw memory", ["raw"], { folder: "research" });
    store.upsertWikiPage({
      path: "research/alpha",
      title: "Alpha",
      content: "alpha synthesized page",
      tags: ["synthesis"],
      sourceMemoryIds: [id],
    });

    expect(store.readWikiPage("research/alpha")).toMatchObject({
      path: "research/alpha.md",
      folder: "research",
      title: "Alpha",
    });
    expect(store.searchWiki("synthesized", 5)[0]).toMatchObject({
      path: "research/alpha.md",
      title: "Alpha",
    });
    expect(store.searchKnowledge("alpha", 10).map((h) => h.source)).toEqual(["wiki"]);
    expect(store.searchKnowledge("alpha", 10, { includeRawSources: false })).toHaveLength(1);
  });

  it("creates and updates a protected user-only LLM usage wiki page", () => {
    const initial = store.readLLMUsageWikiPage();
    expect(initial).toMatchObject({
      path: "system/llm-usage.md",
      folder: "system",
      title: "LLM Usage",
    });
    expect(initial.content).toContain("No LLM calls recorded yet");

    store.recordLLMUsage({
      provider: "openai",
      model: "gpt-test",
      role: "primary",
      kind: "final",
      context: {
        taskKind: "user_message",
        taskName: "discord direct message",
        channel: "discord:dm:u1",
        sessionId: "sess-1",
        conversationId: 42,
        component: "agent",
      },
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      },
      ts: 1_700_000_000_000,
    });
    store.recordLLMUsage({
      provider: "openai",
      model: "gpt-small",
      role: "small",
      kind: "final",
      context: {
        taskKind: "compaction",
        taskName: "conversation #42 compaction",
        channel: "discord:dm:u1",
        conversationId: 42,
        component: "context-windowed",
      },
      usage: {
        inputTokens: 6,
        outputTokens: 2,
      },
      ts: 1_700_000_000_001,
    });

    const updated = store.readLLMUsageWikiPage();
    expect(updated.content).toContain("| Calls | 2 |");
    expect(updated.content).toContain("| Input tokens | 16 |");
    expect(updated.content).toContain("| Output tokens | 6 |");
    expect(updated.content).toContain("| Actual messages | 1 | 10 | 4 | 2 | 1 |");
    expect(updated.content).toContain("| Context compaction | 1 | 6 | 2 | 0 | 0 |");
    expect(updated.content).toContain("| primary | openai | gpt-test | 1 | 10 | 4 | 2 | 1 |");
    expect(updated.content).toContain("| Context compaction | small | openai | gpt-small | 1 | 6 | 2 | 0 | 0 |");
    expect(updated.content).toContain("| Discord DM | Actual messages | discord direct message | 1 | 10 | 4 | 2 | 1 |");
  });

  it("does not expose the protected LLM usage page through normal wiki APIs", () => {
    store.recordLLMUsage({
      provider: "anthropic",
      model: "claude-test",
      role: "small",
      kind: "tool_use",
      usage: { inputTokens: 7, outputTokens: 3 },
    });

    expect(store.readWikiPage("system/llm-usage.md")).toBeNull();
    expect(store.listWikiPages(undefined, 10).map((p) => p.path)).not.toContain("system/llm-usage.md");
    expect(store.listWikiFolders().map((f) => f.path)).not.toContain("system");
    expect(store.searchWiki("usage", 10).map((p) => p.path)).not.toContain("system/llm-usage.md");
    expect(store.searchKnowledge("usage", 10).map((p) => p.path)).not.toContain("system/llm-usage.md");
  });

  it("prevents model-maintained wiki actions from modifying the LLM usage page", () => {
    store.recordLLMUsage({
      provider: "openai",
      model: "gpt-test",
      role: "primary",
      kind: "final",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const before = store.readLLMUsageWikiPage().content;

    expect(() =>
      store.upsertWikiPage({
        path: "system/llm-usage.md",
        folder: "system",
        title: "Tampered",
        content: "tampered",
      }),
    ).toThrow(/system-protected/);

    store.applyWikiMaintenanceActions([
      {
        type: "upsert_page",
        path: "system/llm-usage.md",
        folder: "system",
        title: "Tampered",
        content: "tampered",
      },
      {
        type: "add_link",
        fromPath: "system/llm-usage.md",
        toPath: "personal/preferences.md",
      },
    ]);

    const after = store.readLLMUsageWikiPage().content;
    expect(after).toBe(before);
    expect(after).not.toContain("tampered");
  });

  it("falls back to raw source memories while no wiki page matches", () => {
    const id = store.add("fact", "beta raw memory", ["raw"], { folder: "research" });
    expect(store.searchKnowledge("beta", 10)).toEqual([
      expect.objectContaining({
        source: "memory",
        id,
        title: `Raw source memory #${id}`,
        content: "beta raw memory",
      }),
    ]);
    expect(store.searchKnowledge("beta", 10, { includeRawSources: false })).toEqual([]);
  });

  it("claims, completes, and retries maintenance jobs", () => {
    const id = store.add("note", "queued");
    const claimed = store.claimMemoryMaintenanceJobs(10, "worker-1");
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ memoryId: id, attempts: 1, status: "running" });

    store.failMemoryMaintenanceJob(claimed[0]!.id, "bad json", 1);
    const retry = store.pendingMemoryMaintenanceJobs(10);
    expect(retry[0]).toMatchObject({ id: claimed[0]!.id, status: "pending", lastError: "bad json" });

    const claimedAgain = store.claimMemoryMaintenanceJobs(10, "worker-1", Date.now() + 10);
    store.completeMemoryMaintenanceJob(claimedAgain[0]!.id, "ok");
    expect(store.pendingMemoryMaintenanceJobs()).toHaveLength(0);
  });

  it("search returns multiple hits when relevant", () => {
    store.add("fact", "secret token alpha");
    store.add("fact", "another note about alpha");
    const hits = store.search("alpha");
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("conversation messages round-trip in order", () => {
    const conv = store.newConversation();
    store.logTurn(conv, "user", "hi");
    store.logTurn(conv, "assistant", "hello");
    store.logTurn(conv, "user", "what's up");
    const msgs = store.recentMessages(conv, 10);
    expect(msgs.map((m) => m.content)).toEqual(["hi", "hello", "what's up"]);
  });

  it("audit log accepts tool-call records", () => {
    expect(() => {
      store.logToolCall("shell", '{"bin":"ls"}', "exit_code=0", true);
      store.logToolCall("shell", '{"bin":"rm"}', "refused: not on allowlist", false);
    }).not.toThrow();
  });

  it("search handles punctuation safely", () => {
    store.add("fact", "user likes typescript");
    expect(() => store.search("???")).not.toThrow();
    expect(() => store.search("'OR'")).not.toThrow();
  });
});
