import { describe, expect, it, vi } from "vitest";
import type {
  AssistantTurn,
  KnowledgeSearchResult,
  KnowledgeStore,
  LLMProvider,
  MemoryRecord,
  MemoryStore,
  Message,
  ToolSpec,
} from "@miniclaw/core";
import { InMemoryStore } from "@miniclaw/memory-inmemory";
import { approxTokens, CompactingContextManager } from "../src/index.ts";

class NoOpMemory implements MemoryStore {
  add() { return 0; }
  search(): MemoryRecord[] { return []; }
  listRecent(): MemoryRecord[] { return []; }
}

class ScriptedSummarizer implements LLMProvider {
  calls: Array<{ system: string; messages: Message[]; tools: ToolSpec[] }> = [];
  constructor(private readonly text: string) {}
  async chat(opts: { system: string; messages: Message[]; tools: ToolSpec[] }): Promise<AssistantTurn> {
    this.calls.push(opts);
    return { kind: "final", text: this.text };
  }
}

class FakeKnowledge implements KnowledgeStore {
  constructor(private readonly hits: KnowledgeSearchResult[] = [
    {
      source: "wiki" as const,
      path: "personal/preferences.md",
      folder: "personal",
      title: "Preferences",
      content: "Synthesized preference page",
      tags: ["preferences"],
    },
  ]) {}
  searchKnowledge() { return this.hits; }
}

describe("approxTokens", () => {
  it("returns 0 for empty input", () => {
    expect(approxTokens("")).toBe(0);
  });
  it("returns ~length/4 for short ASCII", () => {
    expect(approxTokens("hello world")).toBe(Math.ceil(11 / 4));
  });
});

describe("CompactingContextManager.prepareAsync — under budget", () => {
  it("returns the full history verbatim when projected tokens stay under tokenBudget", async () => {
    const conversations = new InMemoryStore();
    const convId = conversations.newConversation();
    for (let i = 0; i < 3; i++) {
      conversations.logTurn(convId, "user", `u${i}`);
      conversations.logTurn(convId, "assistant", `a${i}`);
    }
    const summarizer = new ScriptedSummarizer("never called");
    const mgr = new CompactingContextManager({
      memory: new NoOpMemory(),
      conversations,
      conversationId: convId,
      summarizer,
      tokenBudget: 10_000,
      keepRecent: 2,
    });
    const { system, messages } = await mgr.prepareAsync("hi");
    expect(summarizer.calls).toHaveLength(0);
    expect(system).not.toMatch(/Summary of earlier conversation:\n/);
    // 6 historical messages + 1 new user = 7.
    expect(messages).toHaveLength(7);
  });

  it("injects wiki retrieval as index entries when KnowledgeStore is available", async () => {
    const conversations = new InMemoryStore();
    const convId = conversations.newConversation();
    const mgr = new CompactingContextManager({
      memory: new NoOpMemory(),
      conversations,
      conversationId: convId,
      summarizer: new ScriptedSummarizer("unused"),
      knowledge: new FakeKnowledge(),
    });

    const { system } = await mgr.prepareAsync("editor?");

    expect(system).toContain("Relevant long-term memory index");
    expect(system).toContain("personal/preferences.md");
    expect(system).toContain("use wiki_read with this path");
    expect(system).not.toContain("Synthesized preference page");
    expect(system).not.toContain("Relevant raw memory source index");
  });

  it("labels raw memory hits as fallback index entries when no wiki page matches yet", async () => {
    const conversations = new InMemoryStore();
    const convId = conversations.newConversation();
    const mgr = new CompactingContextManager({
      memory: new NoOpMemory(),
      conversations,
      conversationId: convId,
      summarizer: new ScriptedSummarizer("unused"),
      knowledge: new FakeKnowledge([
        {
          source: "memory",
          id: 1,
          folder: "personal",
          title: "Raw source memory #1",
          content: "user prefers helix",
          tags: ["editor"],
        },
      ]),
    });

    const { system } = await mgr.prepareAsync("editor?");

    expect(system).toContain("Relevant raw memory source index");
    expect(system).toContain("raw_source id=1");
    expect(system).toContain('title="Raw source memory #1"');
    expect(system).toContain("use search_memory with a targeted query");
    expect(system).not.toContain("user prefers helix");
  });
});

describe("CompactingContextManager.prepareAsync — over budget", () => {
  function bulkyConversation() {
    const conversations = new InMemoryStore();
    const convId = conversations.newConversation();
    // Build a long, token-heavy conversation. Each message is large enough
    // that 20 of them blow past any reasonable budget.
    for (let i = 0; i < 20; i++) {
      conversations.logTurn(convId, "user", `user msg ${i} ` + "x".repeat(400));
      conversations.logTurn(convId, "assistant", `assistant msg ${i} ` + "y".repeat(400));
    }
    return { conversations, convId };
  }

  it("summarizes older turns and prepends the summary to the system prompt", async () => {
    const { conversations, convId } = bulkyConversation();
    const summarizer = new ScriptedSummarizer("user prefers helix; deploys nightly; legal flagged auth.");
    const mgr = new CompactingContextManager({
      memory: new NoOpMemory(),
      conversations,
      conversationId: convId,
      summarizer,
      tokenBudget: 2_000,
      keepRecent: 4,
    });

    const { system, messages } = await mgr.prepareAsync("status?");
    expect(summarizer.calls).toHaveLength(1);
    expect(system).toMatch(/Summary of earlier conversation:\n/);
    expect(system).toContain("user prefers helix");
    // Recent 4 messages + 1 new user = 5.
    expect(messages).toHaveLength(5);
    // The recent slice should be at the tail of the conversation: u18/a18/u19/a19.
    expect(messages.slice(0, 4).map((m) => (m.role === "tool" ? "" : m.content))).toEqual([
      expect.stringContaining("user msg 18"),
      expect.stringContaining("assistant msg 18"),
      expect.stringContaining("user msg 19"),
      expect.stringContaining("assistant msg 19"),
    ]);
  });

  it("caches the summary across consecutive prepareAsync() calls (no new summary cost)", async () => {
    const { conversations, convId } = bulkyConversation();
    const summarizer = new ScriptedSummarizer("cached summary text");
    const mgr = new CompactingContextManager({
      memory: new NoOpMemory(),
      conversations,
      conversationId: convId,
      summarizer,
      tokenBudget: 500,
      keepRecent: 4,
    });

    await mgr.prepareAsync("first");
    await mgr.prepareAsync("second");
    expect(summarizer.calls).toHaveLength(1);
  });

  it("regenerates the summary when a new turn is appended to the older slice", async () => {
    const { conversations, convId } = bulkyConversation();
    const summarizer = new ScriptedSummarizer("regenerated");
    const mgr = new CompactingContextManager({
      memory: new NoOpMemory(),
      conversations,
      conversationId: convId,
      summarizer,
      tokenBudget: 500,
      keepRecent: 4,
    });

    await mgr.prepareAsync("first");
    // Append a couple of new turns so the *older* slice's last message changes.
    conversations.logTurn(convId, "user", "user msg 20 " + "z".repeat(400));
    conversations.logTurn(convId, "assistant", "assistant msg 20 " + "z".repeat(400));
    await mgr.prepareAsync("second");
    expect(summarizer.calls).toHaveLength(2);
  });

  it("chunks very large histories before asking the summarizer", async () => {
    const conversations = new InMemoryStore();
    const convId = conversations.newConversation();
    for (let i = 0; i < 30; i++) {
      conversations.logTurn(convId, "user", `huge user ${i} ` + "x".repeat(1_000));
      conversations.logTurn(convId, "assistant", `huge assistant ${i} ` + "y".repeat(1_000));
    }
    const summarizer = new ScriptedSummarizer("chunk summary");
    const mgr = new CompactingContextManager({
      memory: new NoOpMemory(),
      conversations,
      conversationId: convId,
      summarizer,
      tokenBudget: 500,
      keepRecent: 2,
      summarizerInputBudget: 600,
      summaryMessageMaxChars: 1_200,
    });

    const { system, messages } = await mgr.prepareAsync("status?");

    expect(system).toContain("Summary of earlier conversation");
    expect(messages.at(-1)).toEqual({ role: "user", content: "status?" });
    expect(summarizer.calls.length).toBeGreaterThan(1);
    for (const call of summarizer.calls) {
      const content = (call.messages[0] as { role: "user"; content: string }).content;
      expect(approxTokens(content)).toBeLessThanOrEqual(650);
    }
  });

  it("drops older recent messages if even the recent window exceeds budget", async () => {
    const conversations = new InMemoryStore();
    const convId = conversations.newConversation();
    for (let i = 0; i < 4; i++) {
      conversations.logTurn(convId, "user", `recent user ${i} ` + "u".repeat(2_000));
      conversations.logTurn(convId, "assistant", `recent assistant ${i} ` + "a".repeat(2_000));
    }
    const mgr = new CompactingContextManager({
      memory: new NoOpMemory(),
      conversations,
      conversationId: convId,
      summarizer: new ScriptedSummarizer("summary"),
      tokenBudget: 120,
      keepRecent: 4,
      recentMessageMaxChars: 200,
    });

    const { messages } = await mgr.prepareAsync("next");

    expect(messages.at(-1)).toEqual({ role: "user", content: "next" });
    expect(messages.length).toBeLessThan(5);
  });

  it("sync prepare() does NOT summarize (escape hatch when caller can't await)", () => {
    const { conversations, convId } = bulkyConversation();
    const summarizer = new ScriptedSummarizer("should not be called");
    const mgr = new CompactingContextManager({
      memory: new NoOpMemory(),
      conversations,
      conversationId: convId,
      summarizer,
      tokenBudget: 500,
      keepRecent: 4,
    });
    const { system } = mgr.prepare("hi");
    expect(system).not.toMatch(/Summary of earlier conversation:\n/);
    expect(summarizer.calls).toHaveLength(0);
  });

  it("falls back to verbatim window when there's nothing older than keepRecent", async () => {
    const conversations = new InMemoryStore();
    const convId = conversations.newConversation();
    for (let i = 0; i < 2; i++) {
      conversations.logTurn(convId, "user", `u${i}`);
      conversations.logTurn(convId, "assistant", `a${i}`);
    }
    const summarizer = new ScriptedSummarizer("nope");
    const mgr = new CompactingContextManager({
      memory: new NoOpMemory(),
      conversations,
      conversationId: convId,
      summarizer,
      tokenBudget: 10, // tiny budget
      keepRecent: 4,   // covers entire conversation
    });
    const { system } = await mgr.prepareAsync("hi");
    expect(summarizer.calls).toHaveLength(0);
    expect(system).not.toMatch(/Summary of earlier conversation:\n/);
  });
});

describe("CompactingContextManager.recordUser / recordAssistant", () => {
  it("delegates to ConversationStore.logTurn", () => {
    const conversations = new InMemoryStore();
    const convId = conversations.newConversation();
    const logSpy = vi.spyOn(conversations, "logTurn");
    const mgr = new CompactingContextManager({
      memory: new NoOpMemory(),
      conversations,
      conversationId: convId,
      summarizer: new ScriptedSummarizer("x"),
    });
    mgr.recordUser("u");
    mgr.recordAssistant("a", '[{"x":1}]');
    expect(logSpy).toHaveBeenNthCalledWith(1, convId, "user", "u");
    expect(logSpy).toHaveBeenNthCalledWith(2, convId, "assistant", "a", '[{"x":1}]');
  });
});
