import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type AssistantTurn,
  type LLMProvider,
  ok,
  type Skill,
  SkillRegistry,
} from "@miniclaw/core";
import { WindowedContextManager } from "@miniclaw/context-windowed";
import { SqliteStore } from "@miniclaw/memory-sqlite";

import { Agent } from "../src/index.ts";

class FakeLLM implements LLMProvider {
  private idx = 0;
  constructor(private readonly turns: AssistantTurn[]) {}
  async chat() {
    const t = this.turns[this.idx++];
    if (!t) throw new Error("ran out of scripted turns");
    return t;
  }
}

const sensitiveSkill: Skill<{ x: number }> = {
  name: "sensitive",
  description: "a skill that requires confirmation",
  parameters: z.object({ x: z.number() }),
  requiresConfirmation: true,
  execute: ({ x }) => ok(`did it with ${x}`),
};

describe("Agent.requiresConfirmation", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-confirm-"));
    store = new SqliteStore(join(dir, "test.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function buildAgent(confirmTool?: (call: { name: string }, skill: { name: string }) => Promise<boolean>) {
    const registry = new SkillRegistry();
    registry.register(sensitiveSkill);
    const convId = store.newConversation();
    const context = new WindowedContextManager({
      memory: store, conversations: store, conversationId: convId,
    });
    const llm = new FakeLLM([
      {
        kind: "tool_use",
        text: "",
        toolCalls: [{ id: "c1", name: "sensitive", args: { x: 7 } }],
      },
      { kind: "final", text: "done" },
    ]);
    return new Agent({
      llm, registry, context, memory: store, audit: store, dbPath: store.path, confirmTool,
    });
  }

  it("runs the skill when confirmTool returns true", async () => {
    const confirmTool = vi.fn(async () => true);
    const trace = await buildAgent(confirmTool).runTurn("please");
    expect(confirmTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "sensitive", args: { x: 7 } }),
      expect.objectContaining({ name: "sensitive" }),
    );
    expect(trace.toolCalls[0]!.ok).toBe(true);
    expect(trace.toolCalls[0]!.output).toContain("did it with 7");
  });

  it("denies the skill when confirmTool returns false", async () => {
    const confirmTool = vi.fn(async () => false);
    const trace = await buildAgent(confirmTool).runTurn("please");
    expect(trace.toolCalls[0]!.ok).toBe(false);
    expect(trace.toolCalls[0]!.output).toMatch(/declined/);
  });

  it("fails closed when no confirmTool is configured", async () => {
    const trace = await buildAgent(undefined).runTurn("please");
    expect(trace.toolCalls[0]!.ok).toBe(false);
    expect(trace.toolCalls[0]!.output).toMatch(/no confirmation handler/);
  });

  it("does NOT call confirmTool for skills without requiresConfirmation", async () => {
    const benignSkill: Skill<{ y: number }> = {
      name: "benign",
      description: "no confirmation needed",
      parameters: z.object({ y: z.number() }),
      execute: ({ y }) => ok(`ok ${y}`),
    };
    const registry = new SkillRegistry();
    registry.register(benignSkill);
    const convId = store.newConversation();
    const context = new WindowedContextManager({
      memory: store, conversations: store, conversationId: convId,
    });
    const llm = new FakeLLM([
      {
        kind: "tool_use",
        text: "",
        toolCalls: [{ id: "c1", name: "benign", args: { y: 1 } }],
      },
      { kind: "final", text: "done" },
    ]);
    const confirmTool = vi.fn(async () => true);
    const agent = new Agent({
      llm, registry, context, memory: store, audit: store, dbPath: store.path, confirmTool,
    });

    const trace = await agent.runTurn("hi");
    expect(confirmTool).not.toHaveBeenCalled();
    expect(trace.toolCalls[0]!.ok).toBe(true);
  });
});
