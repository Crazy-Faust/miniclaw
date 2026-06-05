import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/index.ts";

describe("InMemoryStore — conversation listing/loading", () => {
  it("listConversations returns [] when empty", () => {
    expect(new InMemoryStore().listConversations()).toEqual([]);
  });

  it("listConversations summarizes + orders newest first", () => {
    const s = new InMemoryStore();
    const a = s.newConversation();
    s.logTurn(a, "user", "old");
    const b = s.newConversation();
    s.logTurn(b, "user", "new");

    const list = s.listConversations();
    expect(list[0]!.id).toBe(b);
    expect(list[1]!.id).toBe(a);
    expect(list[0]!.messageCount).toBe(1);
  });

  it("listConversations honors limit", () => {
    const s = new InMemoryStore();
    for (let i = 0; i < 4; i++) {
      const id = s.newConversation();
      s.logTurn(id, "user", `m${i}`);
    }
    expect(s.listConversations(2)).toHaveLength(2);
  });

  it("loadConversation returns messages chronologically and is conv-scoped", () => {
    const s = new InMemoryStore();
    const a = s.newConversation();
    const b = s.newConversation();
    s.logTurn(a, "user", "alpha");
    s.logTurn(b, "user", "beta");
    s.logTurn(a, "assistant", "gamma");

    expect(s.loadConversation(a).map((m) => m.content)).toEqual(["alpha", "gamma"]);
    expect(s.loadConversation(b).map((m) => m.content)).toEqual(["beta"]);
    expect(s.loadConversation(99)).toEqual([]);
  });

  it("loadConversation returns copies (mutating the result doesn't affect store)", () => {
    const s = new InMemoryStore();
    const id = s.newConversation();
    s.logTurn(id, "user", "x");
    const copy = s.loadConversation(id);
    copy[0]!.content = "mutated";
    expect(s.loadConversation(id)[0]!.content).toBe("x");
  });
});
