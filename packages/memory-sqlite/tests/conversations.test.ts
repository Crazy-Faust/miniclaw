import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../src/index.ts";

describe("SqliteStore — conversation listing/loading", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-conv-"));
    store = new SqliteStore(join(dir, "test.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("listConversations returns [] when nothing has been started", () => {
    expect(store.listConversations()).toEqual([]);
  });

  it("listConversations summarizes each conversation with messageCount + lastActivityAt", () => {
    const a = store.newConversation();
    store.logTurn(a, "user", "hi");
    store.logTurn(a, "assistant", "hello");
    const b = store.newConversation();
    store.logTurn(b, "user", "what time is it?");

    const list = store.listConversations();
    expect(list).toHaveLength(2);
    const summaryB = list.find((s) => s.id === b)!;
    const summaryA = list.find((s) => s.id === a)!;
    expect(summaryA.messageCount).toBe(2);
    expect(summaryB.messageCount).toBe(1);
    // lastActivityAt >= startedAt for both.
    expect(summaryA.lastActivityAt).toBeGreaterThanOrEqual(summaryA.startedAt);
  });

  it("listConversations orders newest activity first", () => {
    const a = store.newConversation();
    store.logTurn(a, "user", "old");
    // Pause then create another conversation with newer activity.
    const b = store.newConversation();
    store.logTurn(b, "user", "newer");

    const list = store.listConversations();
    // b was logged most recently → first.
    expect(list[0]!.id).toBe(b);
    expect(list[1]!.id).toBe(a);
  });

  it("listConversations includes empty conversations (using startedAt as lastActivityAt)", () => {
    const c = store.newConversation(); // no messages logged
    const list = store.listConversations();
    const found = list.find((s) => s.id === c)!;
    expect(found.messageCount).toBe(0);
    expect(found.lastActivityAt).toBe(found.startedAt);
  });

  it("listConversations honors the limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      const id = store.newConversation();
      store.logTurn(id, "user", `m${i}`);
    }
    expect(store.listConversations(2)).toHaveLength(2);
    expect(store.listConversations(10)).toHaveLength(5);
  });

  it("loadConversation returns every message in chronological order", () => {
    const id = store.newConversation();
    store.logTurn(id, "user", "first");
    store.logTurn(id, "assistant", "second", '[{"id":"x"}]');
    store.logTurn(id, "user", "third");

    const msgs = store.loadConversation(id);
    expect(msgs.map((m) => m.content)).toEqual(["first", "second", "third"]);
    expect(msgs[1]!.toolCallsJson).toBe('[{"id":"x"}]');
  });

  it("loadConversation returns [] for an unknown id", () => {
    expect(store.loadConversation(99999)).toEqual([]);
  });

  it("loadConversation is scoped — does not leak messages from sibling conversations", () => {
    const a = store.newConversation();
    const b = store.newConversation();
    store.logTurn(a, "user", "in A");
    store.logTurn(b, "user", "in B");
    expect(store.loadConversation(a).map((m) => m.content)).toEqual(["in A"]);
    expect(store.loadConversation(b).map((m) => m.content)).toEqual(["in B"]);
  });
});
