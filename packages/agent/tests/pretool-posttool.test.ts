import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type AssistantTurn,
  fail,
  type LLMProvider,
  ok,
  type Skill,
  SkillRegistry,
} from "@miniclaw/core";
import { WindowedContextManager } from "@miniclaw/context-windowed";
import { SqliteStore } from "@miniclaw/memory-sqlite";

import { Agent, type ToolGuard } from "../src/index.ts";

class ScriptedLLM implements LLMProvider {
  private idx = 0;
  constructor(private readonly turns: AssistantTurn[]) {}
  async chat(): Promise<AssistantTurn> {
    const t = this.turns[this.idx++];
    if (!t) throw new Error("ScriptedLLM ran out of scripted turns");
    return t;
  }
}

function buildAgent(
  store: SqliteStore,
  llm: LLMProvider,
  registry: SkillRegistry,
  toolGuard?: ToolGuard,
) {
  const convId = store.newConversation();
  const context = new WindowedContextManager({
    memory: store, conversations: store, conversationId: convId,
  });
  return new Agent({ llm, registry, context, memory: store, audit: store, dbPath: store.path, toolGuard });
}

describe("Agent — onPreToolUse hook", () => {
  let dir: string;
  let store: SqliteStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-pretool-"));
    store = new SqliteStore(join(dir, "test.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("can veto a tool call; agent records the refusal and the skill never runs", async () => {
    const executed: number[] = [];
    const t: Skill<{ x: number }> = {
      name: "run",
      description: "runs",
      parameters: z.object({ x: z.number() }),
      execute({ x }) { executed.push(x); return ok(`ran ${x}`); },
    };
    const registry = new SkillRegistry();
    registry.register(t);

    const llm = new ScriptedLLM([
      { kind: "tool_use", text: "", toolCalls: [{ id: "c1", name: "run", args: { x: 42 } }] },
      { kind: "final", text: "couldn't run that" },
    ]);
    const agent = buildAgent(store, llm, registry);

    const trace = await agent.runTurn("do it", {
      onPreToolUse: () => ({ allow: false, reason: "policy: blocked in production" }),
    });
    expect(executed).toEqual([]);
    expect(trace.toolCalls[0]!.ok).toBe(false);
    expect(trace.toolCalls[0]!.output).toBe("policy: blocked in production");

    // The audit row also reflects the refusal.
    const db = new Database(store.path, { readonly: true });
    const row = db.prepare("SELECT ok, result_summary FROM audit_log WHERE skill='run'").get() as {
      ok: number; result_summary: string;
    };
    db.close();
    expect(row.ok).toBe(0);
    expect(row.result_summary).toMatch(/policy: blocked/);
  });

  it("can rewrite args via modifiedArgs; the skill receives the rewritten payload", async () => {
    const observed: Array<{ x: number }> = [];
    const t: Skill<{ x: number }> = {
      name: "run",
      description: "runs",
      parameters: z.object({ x: z.number() }),
      execute(a) { observed.push(a); return ok(`x=${a.x}`); },
    };
    const registry = new SkillRegistry();
    registry.register(t);

    const llm = new ScriptedLLM([
      { kind: "tool_use", text: "", toolCalls: [{ id: "c1", name: "run", args: { x: 1 } }] },
      { kind: "final", text: "done" },
    ]);
    const agent = buildAgent(store, llm, registry);

    await agent.runTurn("do it", {
      onPreToolUse: () => ({ allow: true, modifiedArgs: { x: 999 } }),
    });
    expect(observed).toEqual([{ x: 999 }]);
  });

  it("rewritten args still go through zod validation (bad rewrite → invalid arguments)", async () => {
    const t: Skill<{ x: number }> = {
      name: "run",
      description: "runs",
      parameters: z.object({ x: z.number() }),
      execute() { return ok("ran"); },
    };
    const registry = new SkillRegistry();
    registry.register(t);

    const llm = new ScriptedLLM([
      { kind: "tool_use", text: "", toolCalls: [{ id: "c1", name: "run", args: { x: 1 } }] },
      { kind: "final", text: "done" },
    ]);
    const agent = buildAgent(store, llm, registry);

    const trace = await agent.runTurn("do it", {
      onPreToolUse: () => ({ allow: true, modifiedArgs: { x: "not-a-number" } }),
    });
    expect(trace.toolCalls[0]!.ok).toBe(false);
    expect(trace.toolCalls[0]!.output).toMatch(/invalid arguments/);
  });

  it("a returning hook with no decision is equivalent to allow:true (no-op observer)", async () => {
    const t: Skill<{ x: number }> = {
      name: "run",
      description: "runs",
      parameters: z.object({ x: z.number() }),
      execute({ x }) { return ok(`ran ${x}`); },
    };
    const registry = new SkillRegistry();
    registry.register(t);

    const llm = new ScriptedLLM([
      { kind: "tool_use", text: "", toolCalls: [{ id: "c1", name: "run", args: { x: 5 } }] },
      { kind: "final", text: "done" },
    ]);
    const agent = buildAgent(store, llm, registry);

    const seen: Array<{ name: string; args: unknown }> = [];
    const trace = await agent.runTurn("go", {
      onPreToolUse: (call) => { seen.push(call); /* no return */ },
    });
    expect(seen).toEqual([{ name: "run", args: { x: 5 } }]);
    expect(trace.toolCalls[0]!.ok).toBe(true);
    expect(trace.toolCalls[0]!.output).toBe("ran 5");
  });
});

describe("Agent — dependency toolGuard", () => {
  let dir: string;
  let store: SqliteStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-toolguard-"));
    store = new SqliteStore(join(dir, "test.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs before execution, receives the original user request, and can deny", async () => {
    const executed: unknown[] = [];
    const t: Skill<{ path: string }> = {
      name: "delete_file",
      description: "deletes one file",
      parameters: z.object({ path: z.string() }),
      execute(args) { executed.push(args); return ok("deleted"); },
    };
    const registry = new SkillRegistry();
    registry.register(t);
    const llm = new ScriptedLLM([
      {
        kind: "tool_use",
        text: "",
        toolCalls: [{ id: "c1", name: "delete_file", args: { path: "/tmp/a" } }],
      },
      { kind: "final", text: "blocked" },
    ]);
    const seen: unknown[] = [];
    const agent = buildAgent(store, llm, registry, (input) => {
      seen.push(input);
      return { allow: false, reason: "security denied delete_file: destructive mismatch" };
    });

    const trace = await agent.runTurn("please list files");

    expect(executed).toEqual([]);
    expect(seen).toEqual([
      {
        userMessage: "please list files",
        call: { name: "delete_file", args: { path: "/tmp/a" } },
        skill: { name: "delete_file", description: "deletes one file" },
      },
    ]);
    expect(trace.toolCalls[0]).toMatchObject({
      name: "delete_file",
      ok: false,
      output: "security denied delete_file: destructive mismatch",
    });
  });

  it("evaluates args after the session pre-tool hook rewrites them", async () => {
    const observed: unknown[] = [];
    const t: Skill<{ x: number }> = {
      name: "run",
      description: "runs",
      parameters: z.object({ x: z.number() }),
      execute(args) { observed.push(args); return ok(`x=${args.x}`); },
    };
    const registry = new SkillRegistry();
    registry.register(t);
    const llm = new ScriptedLLM([
      { kind: "tool_use", text: "", toolCalls: [{ id: "c1", name: "run", args: { x: 1 } }] },
      { kind: "final", text: "done" },
    ]);
    const seen: unknown[] = [];
    const agent = buildAgent(store, llm, registry, (input) => {
      seen.push(input.call.args);
      return { allow: true };
    });

    await agent.runTurn("go", {
      onPreToolUse: () => ({ allow: true, modifiedArgs: { x: 2 } }),
    });

    expect(seen).toEqual([{ x: 2 }]);
    expect(observed).toEqual([{ x: 2 }]);
  });
});

describe("Agent — onPostToolUse hook", () => {
  let dir: string;
  let store: SqliteStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-posttool-"));
    store = new SqliteStore(join(dir, "test.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fires once per tool call with the actual result", async () => {
    const t: Skill<{ x: number; bad?: boolean }> = {
      name: "run",
      description: "runs",
      parameters: z.object({ x: z.number(), bad: z.boolean().optional() }),
      execute(a) { return a.bad ? fail("nope") : ok(`ran ${a.x}`); },
    };
    const registry = new SkillRegistry();
    registry.register(t);

    const llm = new ScriptedLLM([
      {
        kind: "tool_use",
        text: "",
        toolCalls: [
          { id: "a", name: "run", args: { x: 1 } },
          { id: "b", name: "run", args: { x: 2, bad: true } },
        ],
      },
      { kind: "final", text: "done" },
    ]);
    const agent = buildAgent(store, llm, registry);

    const post = vi.fn();
    await agent.runTurn("go", { onPostToolUse: post });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenNthCalledWith(
      1,
      { name: "run", args: { x: 1 } },
      { ok: true, output: "ran 1" },
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      { name: "run", args: { x: 2, bad: true } },
      { ok: false, output: "nope" },
    );
  });

  it("also fires for refusals from the PreToolUse hook (observer sees the whole story)", async () => {
    const t: Skill<{ x: number }> = {
      name: "run",
      description: "runs",
      parameters: z.object({ x: z.number() }),
      execute() { return ok("never"); },
    };
    const registry = new SkillRegistry();
    registry.register(t);

    const llm = new ScriptedLLM([
      { kind: "tool_use", text: "", toolCalls: [{ id: "c1", name: "run", args: { x: 1 } }] },
      { kind: "final", text: "ok" },
    ]);
    const agent = buildAgent(store, llm, registry);

    const post = vi.fn();
    await agent.runTurn("go", {
      onPreToolUse: () => ({ allow: false, reason: "blocked" }),
      onPostToolUse: post,
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[1]).toEqual({ ok: false, output: "blocked" });
  });

  it("a throwing PostToolUse hook does not crash the turn", async () => {
    const t: Skill<{ x: number }> = {
      name: "run",
      description: "runs",
      parameters: z.object({ x: z.number() }),
      execute({ x }) { return ok(`ran ${x}`); },
    };
    const registry = new SkillRegistry();
    registry.register(t);

    const llm = new ScriptedLLM([
      { kind: "tool_use", text: "", toolCalls: [{ id: "c1", name: "run", args: { x: 1 } }] },
      { kind: "final", text: "ok" },
    ]);
    const agent = buildAgent(store, llm, registry);

    const trace = await agent.runTurn("go", {
      onPostToolUse: () => { throw new Error("observer boom"); },
    });
    expect(trace.toolCalls[0]!.ok).toBe(true);
    expect(trace.finalText).toBe("ok");
  });
});
