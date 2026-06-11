import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "@miniclaw/memory-sqlite";
import { WindowedContextManager } from "../src/index.ts";

// Integration: context manager + real SQLite store. Asserts that FTS5
// retrieval and conversation persistence work end-to-end through the
// ContextManager interface.

describe("context-windowed ↔ memory-sqlite", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-ctx-int-"));
    store = new SqliteStore(join(dir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prepare() injects matching raw memories from FTS5 into the system prompt without KnowledgeStore", () => {
    store.add("preference", "user prefers the helix editor", ["editor"]);
    store.add("fact", "user lives in Berlin", []);

    const convId = store.newConversation();
    const ctx = new WindowedContextManager({
      memory: store,
      conversations: store,
      conversationId: convId,
    });

    const { system, messages } = ctx.prepare("which editor do I use?");
    expect(system).toMatch(/Relevant raw memories/);
    expect(system).toContain("helix");
    // Unrelated memory should not be injected for an editor query under FTS.
    expect(system).not.toContain("Berlin");
    expect(messages.at(-1)).toEqual({ role: "user", content: "which editor do I use?" });
  });

  it("prepare() returns just the user message when nothing matches FTS", () => {
    store.add("note", "completely unrelated content", []);
    const convId = store.newConversation();
    const ctx = new WindowedContextManager({
      memory: store,
      conversations: store,
      conversationId: convId,
    });

    const { system, messages } = ctx.prepare("xylophone wavelength sky");
    expect(system).not.toMatch(/Relevant raw memories/);
    expect(messages).toEqual([{ role: "user", content: "xylophone wavelength sky" }]);
  });

  it("recorded turns become history on the next prepare()", () => {
    const convId = store.newConversation();
    const ctx = new WindowedContextManager({
      memory: store,
      conversations: store,
      conversationId: convId,
    });

    ctx.recordUser("hello");
    ctx.recordAssistant("hi there");
    ctx.recordUser("how are you");
    ctx.recordAssistant("fine");

    const { messages } = ctx.prepare("again");
    expect(messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "how are you" },
      { role: "assistant", content: "fine" },
      { role: "user", content: "again" },
    ]);
  });

  it("filters tool turns out of history even when stored", () => {
    const convId = store.newConversation();
    const ctx = new WindowedContextManager({
      memory: store,
      conversations: store,
      conversationId: convId,
    });

    ctx.recordUser("u1");
    // The agent writes "tool" turns by directly calling store.logTurn, so we
    // do the same here to simulate that path.
    store.logTurn(convId, "tool", "<json>");
    ctx.recordAssistant("a1");

    const { messages } = ctx.prepare("next");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("isolates history per conversationId", () => {
    const convA = store.newConversation();
    const convB = store.newConversation();
    const ctxA = new WindowedContextManager({
      memory: store,
      conversations: store,
      conversationId: convA,
    });
    const ctxB = new WindowedContextManager({
      memory: store,
      conversations: store,
      conversationId: convB,
    });

    ctxA.recordUser("in A");
    ctxB.recordUser("in B");

    const { messages: aMsgs } = ctxA.prepare("?");
    const { messages: bMsgs } = ctxB.prepare("?");
    const contents = (ms: typeof aMsgs) =>
      ms.map((m) => (m.role === "tool" ? "<tool>" : m.content));
    expect(contents(aMsgs)).toEqual(["in A", "?"]);
    expect(contents(bMsgs)).toEqual(["in B", "?"]);
  });
});
