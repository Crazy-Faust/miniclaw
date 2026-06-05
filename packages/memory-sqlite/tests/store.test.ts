import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("FTS5 search finds inserted content", () => {
    store.add("fact", "user prefers the helix editor");
    store.add("fact", "user prefers oat milk in coffee");
    const hits = store.search("helix");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toContain("helix");
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
