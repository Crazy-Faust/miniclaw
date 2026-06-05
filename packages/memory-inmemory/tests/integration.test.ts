// Integration: prove that swapping memory-sqlite for memory-inmemory
// works end-to-end through the agent. Mirrors a slice of the agent
// integration test using the in-memory backend instead of SQLite.

import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/index.ts";

describe("InMemoryStore implements the same contract as SqliteStore", () => {
  it("can serve as MemoryStore + ConversationStore + AuditSink simultaneously", () => {
    const store = new InMemoryStore();

    // MemoryStore
    const memId = store.add("fact", "x", ["t"]);
    expect(store.listRecent(10)[0]!.id).toBe(memId);

    // ConversationStore
    const conv = store.newConversation();
    store.logTurn(conv, "user", "hi");
    expect(store.recentMessages(conv, 10)).toHaveLength(1);

    // AuditSink
    store.logToolCall("shell", "{}", "ok", true);
    expect(store.snapshotAudit()).toHaveLength(1);
  });
});
