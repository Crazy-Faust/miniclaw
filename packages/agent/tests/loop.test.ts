import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type AssistantTurn,
  type LLMProvider,
  SkillRegistry,
} from "@miniclaw/core";
import { WindowedContextManager } from "@miniclaw/context-windowed";
import { SqliteStore } from "@miniclaw/memory-sqlite";
import { searchMemorySkill, writeMemorySkill } from "@miniclaw/agent-skills";

import { Agent } from "../src/index.ts";

class FakeLLM implements LLMProvider {
  constructor(private readonly turns: AssistantTurn[]) {}
  calls = 0;
  async chat(): Promise<AssistantTurn> {
    const t = this.turns[this.calls++];
    if (!t) throw new Error("FakeLLM ran out of scripted turns");
    return t;
  }
}

describe("Agent loop", () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-agent-"));
    dbPath = join(dir, "test.db");
    store = new SqliteStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("dispatches a tool call then returns the final text", async () => {
    const registry = new SkillRegistry();
    registry.register(writeMemorySkill);
    registry.register(searchMemorySkill);

    const llm = new FakeLLM([
      {
        kind: "tool_use",
        text: "",
        toolCalls: [
          {
            id: "call_1",
            name: "write_memory",
            args: { content: "user likes typescript", kind: "preference", tags: ["lang"] },
          },
        ],
      },
      { kind: "final", text: "Got it — I'll remember that." },
    ]);

    const convId = store.newConversation();
    const context = new WindowedContextManager({
      memory: store,
      conversations: store,
      conversationId: convId,
    });
    const agent = new Agent({
      llm, registry, context, memory: store, audit: store, dbPath,
    });

    const trace = await agent.runTurn("remember I like typescript");
    expect(trace.finalText).toMatch(/remember/i);
    expect(trace.toolCalls).toHaveLength(1);
    expect(trace.toolCalls[0]!.ok).toBe(true);
    expect(trace.toolCalls[0]!.name).toBe("write_memory");

    const hits = store.search("typescript");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toContain("typescript");
  });

  it("returns a tool error when args fail validation", async () => {
    const registry = new SkillRegistry();
    registry.register(writeMemorySkill);

    const llm = new FakeLLM([
      {
        kind: "tool_use",
        text: "",
        toolCalls: [{ id: "call_1", name: "write_memory", args: { content: "" } }],
      },
      { kind: "final", text: "Sorry, that didn't work." },
    ]);

    const convId = store.newConversation();
    const context = new WindowedContextManager({
      memory: store, conversations: store, conversationId: convId,
    });
    const agent = new Agent({ llm, registry, context, memory: store, audit: store, dbPath });

    const trace = await agent.runTurn("remember nothing");
    expect(trace.toolCalls[0]!.ok).toBe(false);
    expect(trace.toolCalls[0]!.output).toMatch(/invalid arguments/);
  });

  it("stops after MAX_ROUNDS of tool calls", async () => {
    const registry = new SkillRegistry();
    registry.register(searchMemorySkill);

    const loopingTurn: AssistantTurn = {
      kind: "tool_use",
      text: "",
      toolCalls: [{ id: "x", name: "search_memory", args: { query: "anything" } }],
    };
    const llm = new FakeLLM(Array.from({ length: 20 }, () => loopingTurn));

    const convId = store.newConversation();
    const context = new WindowedContextManager({
      memory: store, conversations: store, conversationId: convId,
    });
    const agent = new Agent({ llm, registry, context, memory: store, audit: store, dbPath });

    const trace = await agent.runTurn("loop please");
    expect(trace.finalText).toMatch(/round limit/);
  });

  it("synthesizes a best-effort answer when the round limit is hit", async () => {
    const registry = new SkillRegistry();
    registry.register(searchMemorySkill);

    const loopingTurn: AssistantTurn = {
      kind: "tool_use",
      text: "",
      toolCalls: [{ id: "x", name: "search_memory", args: { query: "anything" } }],
    };
    // Six tool-use rounds exhaust MAX_ROUNDS; the final tool-free wrap-up call
    // returns a best-effort answer instead of the model looping forever.
    const wrapUp: AssistantTurn = {
      kind: "final",
      text: "Here is my best answer from what I gathered; I couldn't finish the search.",
    };
    const llm = new FakeLLM([...Array.from({ length: 6 }, () => loopingTurn), wrapUp]);

    const convId = store.newConversation();
    const context = new WindowedContextManager({
      memory: store, conversations: store, conversationId: convId,
    });
    const agent = new Agent({ llm, registry, context, memory: store, audit: store, dbPath });

    const trace = await agent.runTurn("loop please");
    expect(trace.finalText).toBe(wrapUp.text);
    expect(trace.finalText).not.toMatch(/round limit/);
    expect(llm.calls).toBe(7); // 6 rounds + 1 tool-free wrap-up
  });
});
