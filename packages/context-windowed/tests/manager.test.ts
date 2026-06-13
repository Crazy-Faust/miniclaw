import { describe, expect, it, vi } from "vitest";
import type {
  ConversationStore,
  MemoryRecord,
  MemoryStore,
  MessageRecord,
} from "@miniclaw/core";
import { WindowedContextManager } from "../src/index.ts";

class FakeMemoryStore implements MemoryStore {
  hits: MemoryRecord[] = [];
  searchSpy = vi.fn<(q: string, limit: number) => MemoryRecord[]>(() => this.hits);
  add() { return 0; }
  search(query: string, limit = 5): MemoryRecord[] { return this.searchSpy(query, limit); }
  listRecent(): MemoryRecord[] { return []; }
}

class FakeConversationStore implements ConversationStore {
  history: MessageRecord[] = [];
  logged: Array<{ convId: number; role: string; content: string; toolCallsJson: string | null }> = [];
  newConversation() { return 1; }
  logTurn(convId: number, role: string, content: string, toolCallsJson: string | null = null): void {
    this.logged.push({ convId, role, content, toolCallsJson });
  }
  recentMessages(): MessageRecord[] { return this.history; }
  listConversations() { return []; }
  loadConversation() { return [...this.history]; }
}

function makeMemoryRecord(id: number, kind: string, content: string): MemoryRecord {
  return { id, kind, content, tags: [], createdAt: 0 };
}

function makeMessageRecord(id: number, role: string, content: string): MessageRecord {
  return { id, convId: 1, role, content, toolCallsJson: null, createdAt: id };
}

describe("WindowedContextManager.prepare", () => {
  it("returns a system prompt + appended user message when there's no history or memory", () => {
    const memory = new FakeMemoryStore();
    const conversations = new FakeConversationStore();
    const mgr = new WindowedContextManager({ memory, conversations, conversationId: 1 });

    const { system, messages } = mgr.prepare("hello");
    expect(system).toMatch(/miniclaw/);
    expect(system).not.toMatch(/Relevant raw memory index/);
    expect(messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("injects retrieved memories as pointers into the system prompt", () => {
    const memory = new FakeMemoryStore();
    memory.hits = [
      makeMemoryRecord(7, "preference", "user prefers helix"),
      makeMemoryRecord(8, "fact", "lives in Berlin"),
    ];
    const conversations = new FakeConversationStore();
    const mgr = new WindowedContextManager({ memory, conversations, conversationId: 1 });

    const { system } = mgr.prepare("what editor do I use?");
    expect(system).toMatch(/Relevant raw memory index/);
    expect(system).toContain('raw_source id=7 kind="preference"');
    expect(system).toContain('raw_source id=8 kind="fact"');
    expect(system).toContain("use search_memory with a targeted query");
    expect(system).not.toContain("user prefers helix");
    expect(system).not.toContain("lives in Berlin");
  });

  it("forwards historyTurns and memoryHits to the stores", () => {
    const memory = new FakeMemoryStore();
    const conversations = new FakeConversationStore();
    const recentSpy = vi.spyOn(conversations, "recentMessages");

    const mgr = new WindowedContextManager({
      memory,
      conversations,
      conversationId: 1,
      historyTurns: 4,
      memoryHits: 2,
    });
    mgr.prepare("q");

    expect(memory.searchSpy).toHaveBeenCalledWith("q", 2);
    expect(recentSpy).toHaveBeenCalledWith(1, 4);
  });

  it("includes prior user/assistant history before the new user message", () => {
    const memory = new FakeMemoryStore();
    const conversations = new FakeConversationStore();
    conversations.history = [
      makeMessageRecord(1, "user", "hi"),
      makeMessageRecord(2, "assistant", "hello"),
    ];
    const mgr = new WindowedContextManager({ memory, conversations, conversationId: 1 });

    const { messages } = mgr.prepare("again");
    expect(messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" },
    ]);
  });

  it("filters out roles other than user/assistant from history (e.g. tool turns)", () => {
    const memory = new FakeMemoryStore();
    const conversations = new FakeConversationStore();
    conversations.history = [
      makeMessageRecord(1, "user", "hi"),
      makeMessageRecord(2, "tool", "<json>"),
      makeMessageRecord(3, "assistant", "hello"),
    ];
    const mgr = new WindowedContextManager({ memory, conversations, conversationId: 1 });

    const { messages } = mgr.prepare("again");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("WindowedContextManager.recordUser/recordAssistant", () => {
  it("delegates to ConversationStore.logTurn with the right role and convId", () => {
    const memory = new FakeMemoryStore();
    const conversations = new FakeConversationStore();
    const mgr = new WindowedContextManager({ memory, conversations, conversationId: 42 });

    mgr.recordUser("u1");
    mgr.recordAssistant("a1", '[{"id":"x"}]');

    expect(conversations.logged).toEqual([
      { convId: 42, role: "user", content: "u1", toolCallsJson: null },
      { convId: 42, role: "assistant", content: "a1", toolCallsJson: '[{"id":"x"}]' },
    ]);
  });
});
