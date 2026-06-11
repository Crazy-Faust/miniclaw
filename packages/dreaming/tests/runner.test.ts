import { describe, expect, it } from "vitest";
import {
  type AssistantTurn,
  type LLMProvider,
  SkillRegistry,
  type Message,
  type ToolSpec,
} from "@miniclaw/core";
import { InMemoryStore } from "@miniclaw/memory-inmemory";
import { searchMemorySkill, writeMemorySkill } from "@miniclaw/skills-memory";
import {
  buildDreamTranscript,
  createDreamSkill,
  Dreamer,
} from "../src/index.ts";

class ScriptedLLM implements LLMProvider {
  calls: Array<{ system: string; messages: Message[]; tools: ToolSpec[] }> = [];
  constructor(private readonly turns: AssistantTurn[]) {}
  async chat(opts: { system: string; messages: Message[]; tools: ToolSpec[] }): Promise<AssistantTurn> {
    this.calls.push(opts);
    const turn = this.turns.shift();
    if (!turn) throw new Error("ScriptedLLM ran out of turns");
    return turn;
  }
}

function registryWithMemory(): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register(searchMemorySkill);
  registry.register(writeMemorySkill);
  return registry;
}

describe("buildDreamTranscript", () => {
  it("includes recent conversations and truncates historical tool calls", () => {
    const store = new InMemoryStore();
    const convId = store.newConversation();
    store.logTurn(convId, "user", "remember that I like helix");
    store.logTurn(
      convId,
      "assistant",
      "I will remember that.",
      JSON.stringify([{ id: "t1", name: "write_memory", args: { content: "x".repeat(200) } }]),
    );

    const transcript = buildDreamTranscript(store, {
      conversationLimit: 1,
      messagesPerConversation: 5,
      maxToolCallChars: 80,
    });

    expect(transcript.conversationsScanned).toBe(1);
    expect(transcript.messagesScanned).toBe(2);
    expect(transcript.text).toContain("Conversation #1");
    expect(transcript.text).toContain("tool_calls:");
    expect(transcript.text).toContain("chars truncated");
  });
});

describe("Dreamer", () => {
  it("runs a dream pass through the normal agent loop and can write memory", async () => {
    const store = new InMemoryStore();
    const convId = store.newConversation();
    store.logTurn(convId, "user", "I prefer helix for editing TypeScript.");
    store.logTurn(convId, "assistant", "Noted.");

    const llm = new ScriptedLLM([
      {
        kind: "tool_use",
        text: "",
        toolCalls: [
          {
            id: "mem1",
            name: "write_memory",
            args: {
              kind: "preference",
              content: "User prefers helix for editing TypeScript.",
              tags: ["dream", "editor"],
            },
          },
        ],
      },
      { kind: "final", text: "stored editor preference" },
    ]);
    const dreamer = new Dreamer({
      llm,
      conversations: store,
      memory: store,
      audit: store,
      registry: registryWithMemory(),
      dbPath: ":memory:",
    });

    const result = await dreamer.run({ conversationLimit: 1 });

    expect(result.finalText).toBe("stored editor preference");
    expect(result.toolCalls).toHaveLength(1);
    expect(store.search("helix TypeScript", 5)).toEqual([
      expect.objectContaining({ kind: "preference" }),
    ]);
    const prompt = llm.calls[0]!.messages[0]!;
    expect(prompt.role).toBe("user");
    expect(prompt.role === "user" ? prompt.content : "").toContain("Transcript:");
  });

  it("filters the internal skill registry to the dream-safe tool set", async () => {
    const store = new InMemoryStore();
    store.newConversation();
    const registry = registryWithMemory();
    registry.register({
      name: "dream",
      description: "recursive dream",
      parameters: createDreamSkill(new Dreamer({
        llm: new ScriptedLLM([{ kind: "final", text: "unused" }]),
        conversations: store,
        memory: store,
        audit: store,
        registry,
        dbPath: ":memory:",
      })).parameters,
      execute: () => ({ ok: true, output: "nope" }),
    });
    const llm = new ScriptedLLM([{ kind: "final", text: "nothing to do" }]);
    const dreamer = new Dreamer({
      llm,
      conversations: store,
      memory: store,
      audit: store,
      registry,
      dbPath: ":memory:",
    });

    await dreamer.run();

    expect(llm.calls[0]!.tools.map((t) => t.name).sort()).toEqual([
      "search_memory",
      "write_memory",
    ]);
  });
});
