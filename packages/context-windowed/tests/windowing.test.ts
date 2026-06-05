import { describe, expect, it } from "vitest";
import type { MemoryRecord, MemoryStore } from "@miniclaw/core";
import { InMemoryStore } from "@miniclaw/memory-inmemory";
import { WindowedContextManager } from "../src/index.ts";

class NoOpMemory implements MemoryStore {
  add() { return 0; }
  search(): MemoryRecord[] { return []; }
  listRecent(): MemoryRecord[] { return []; }
}

// Specifically exercises the historyTurns=12 default and confirms behavior
// in a >12-turn conversation.
describe("WindowedContextManager — 12-turn windowing default", () => {
  it("default historyTurns is 12 and a 20-turn conversation is clipped to the most recent 12", () => {
    const conversations = new InMemoryStore();
    const convId = conversations.newConversation();
    const memory = new NoOpMemory();

    // Log 20 user/assistant pairs (40 messages total) before the new turn.
    for (let i = 0; i < 20; i++) {
      conversations.logTurn(convId, "user", `u${i}`);
      conversations.logTurn(convId, "assistant", `a${i}`);
    }

    const mgr = new WindowedContextManager({ memory, conversations, conversationId: convId });
    const { messages } = mgr.prepare("now what?");

    // Window of 12 historical messages + the new user message.
    expect(messages).toHaveLength(13);
    expect(messages.at(-1)).toEqual({ role: "user", content: "now what?" });

    // The 12 messages should be the most recent six pairs: u14..u19, a14..a19,
    // interleaved in original order.
    const historical = messages.slice(0, 12);
    const expected = [];
    for (let i = 14; i < 20; i++) {
      expected.push({ role: "user", content: `u${i}` });
      expected.push({ role: "assistant", content: `a${i}` });
    }
    expect(historical).toEqual(expected);
  });

  it("an exactly-12-turn conversation includes all of it (no clipping at the boundary)", () => {
    const conversations = new InMemoryStore();
    const convId = conversations.newConversation();
    const memory = new NoOpMemory();
    for (let i = 0; i < 6; i++) {
      conversations.logTurn(convId, "user", `u${i}`);
      conversations.logTurn(convId, "assistant", `a${i}`);
    }
    const mgr = new WindowedContextManager({ memory, conversations, conversationId: convId });
    const { messages } = mgr.prepare("again");
    // 12 historical messages + 1 new = 13.
    expect(messages).toHaveLength(13);
    expect(messages[0]).toEqual({ role: "user", content: "u0" });
  });

  it("a custom historyTurns is honored end-to-end (4-turn window over a 20-turn log)", () => {
    const conversations = new InMemoryStore();
    const convId = conversations.newConversation();
    const memory = new NoOpMemory();
    for (let i = 0; i < 20; i++) {
      conversations.logTurn(convId, "user", `u${i}`);
      conversations.logTurn(convId, "assistant", `a${i}`);
    }
    const mgr = new WindowedContextManager({
      memory,
      conversations,
      conversationId: convId,
      historyTurns: 4,
    });
    const { messages } = mgr.prepare("hi");
    expect(messages).toHaveLength(5);
    expect(messages.slice(0, 4)).toEqual([
      { role: "user", content: "u18" },
      { role: "assistant", content: "a18" },
      { role: "user", content: "u19" },
      { role: "assistant", content: "a19" },
    ]);
  });

  it("tool turns interleaved in a >12-turn conversation are excluded from the window", () => {
    const conversations = new InMemoryStore();
    const convId = conversations.newConversation();
    const memory = new NoOpMemory();
    // 20 turns of (user, assistant, tool) — tool rows must be filtered out.
    for (let i = 0; i < 20; i++) {
      conversations.logTurn(convId, "user", `u${i}`);
      conversations.logTurn(convId, "assistant", `a${i}`);
      conversations.logTurn(convId, "tool", `t${i}`);
    }
    const mgr = new WindowedContextManager({ memory, conversations, conversationId: convId });
    const { messages } = mgr.prepare("?");
    expect(messages.at(-1)).toEqual({ role: "user", content: "?" });
    // No tool roles in the window.
    expect(messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
    // Window of 12 came from the recent slice of the recentMessages() output
    // (which is recent-by-id), then user/assistant filter dropped tools. We
    // shouldn't try to predict the exact slice here — just confirm the
    // window honors the size limit AND excludes tools.
    expect(messages.length).toBeLessThanOrEqual(13);
  });
});
