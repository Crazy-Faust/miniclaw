import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/index.ts";

// Mirrors memory-sqlite/tests/store.test.ts where applicable, so the two
// implementations enforce the same MemoryStore contract.

describe("InMemoryStore", () => {
  it("adds and retrieves recent memories", () => {
    const store = new InMemoryStore();
    const id1 = store.add("fact", "user prefers helix");
    const id2 = store.add("preference", "user prefers dark mode", ["ui"]);
    const recent = store.listRecent(10);
    expect(recent.map((r) => r.id)).toEqual([id2, id1]);
    expect(recent[0]!.tags).toEqual(["ui"]);
  });

  it("search finds inserted content by token overlap", () => {
    const store = new InMemoryStore();
    store.add("fact", "user prefers the helix editor");
    store.add("fact", "user prefers oat milk in coffee");
    const hits = store.search("helix");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toContain("helix");
  });

  it("ranks higher-overlap matches first", () => {
    const store = new InMemoryStore();
    store.add("fact", "alpha"); // 1 token match
    store.add("fact", "alpha beta gamma"); // more overlap with query
    const hits = store.search("alpha beta gamma", 5);
    expect(hits[0]!.content).toBe("alpha beta gamma");
  });

  it("search ignores punctuation in the query (and matches helix even with ?)", () => {
    const store = new InMemoryStore();
    store.add("fact", "the editor is helix");
    expect(() => store.search("???!")).not.toThrow();
    expect(store.search("helix?")).toHaveLength(1);
  });

  it("conversation messages round-trip in order, scoped per convId", () => {
    const store = new InMemoryStore();
    const a = store.newConversation();
    const b = store.newConversation();
    store.logTurn(a, "user", "hi-a");
    store.logTurn(b, "user", "hi-b");
    store.logTurn(a, "assistant", "yo");
    expect(store.recentMessages(a, 10).map((m) => m.content)).toEqual(["hi-a", "yo"]);
    expect(store.recentMessages(b, 10).map((m) => m.content)).toEqual(["hi-b"]);
  });

  it("recentMessages respects the limit (oldest dropped first)", () => {
    const store = new InMemoryStore();
    const c = store.newConversation();
    for (let i = 0; i < 5; i++) store.logTurn(c, "user", `msg-${i}`);
    const last3 = store.recentMessages(c, 3);
    expect(last3.map((m) => m.content)).toEqual(["msg-2", "msg-3", "msg-4"]);
  });

  it("audit log captures successful and failed tool calls", () => {
    const store = new InMemoryStore();
    store.logToolCall("shell", '{"bin":"ls"}', "ok", true);
    store.logToolCall("shell", '{"bin":"rm"}', "refused", false);
    const rows = store.snapshotAudit();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ skill: "shell", ok: true });
    expect(rows[1]).toMatchObject({ skill: "shell", ok: false });
  });
});
