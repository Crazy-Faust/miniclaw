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

import { Agent } from "../src/index.ts";

class ScriptedLLM implements LLMProvider {
  calls: Array<{ system: string; onToken?: unknown }> = [];
  private idx = 0;
  constructor(private readonly turns: AssistantTurn[]) {}
  async chat(opts: {
    system: string;
    onToken?: (delta: string) => void;
  }): Promise<AssistantTurn> {
    this.calls.push({ system: opts.system, onToken: opts.onToken });
    const t = this.turns[this.idx++];
    if (!t) throw new Error("ScriptedLLM ran out of scripted turns");
    return t;
  }
}

// A streaming-capable fake: emits `streamChunks` via opts.onToken before
// returning the corresponding pre-baked turn.
class StreamingLLM implements LLMProvider {
  private idx = 0;
  constructor(
    private readonly script: Array<{ chunks: string[]; turn: AssistantTurn }>,
  ) {}
  async chat(opts: {
    onToken?: (delta: string) => void;
  }): Promise<AssistantTurn> {
    const step = this.script[this.idx++];
    if (!step) throw new Error("StreamingLLM ran out of scripted turns");
    if (opts.onToken) {
      for (const c of step.chunks) opts.onToken(c);
    }
    return step.turn;
  }
}

function buildAgent(store: SqliteStore, llm: LLMProvider, registry: SkillRegistry) {
  const convId = store.newConversation();
  const context = new WindowedContextManager({
    memory: store,
    conversations: store,
    conversationId: convId,
  });
  return new Agent({
    llm,
    registry,
    context,
    memory: store,
    audit: store,
    dbPath: store.path,
  });
}

describe("Agent — recordAssistant fix", () => {
  let dir: string;
  let store: SqliteStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-record-"));
    store = new SqliteStore(join(dir, "test.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists the model's real text in a tool_use round, not the '(tool use)' sentinel", async () => {
    const benign: Skill<{ x: number }> = {
      name: "benign",
      description: "no-op",
      parameters: z.object({ x: z.number() }),
      execute: ({ x }) => ok(`ran ${x}`),
    };
    const registry = new SkillRegistry();
    registry.register(benign);

    const llm = new ScriptedLLM([
      {
        kind: "tool_use",
        text: "Looking that up now.",
        toolCalls: [{ id: "c1", name: "benign", args: { x: 1 } }],
      },
      { kind: "final", text: "All set." },
    ]);

    const agent = buildAgent(store, llm, registry);
    await agent.runTurn("please do it");

    // Read messages directly from the SQLite store and confirm the assistant
    // row from the tool_use round stored the actual narration text — and
    // NOT the legacy "(tool use)" sentinel.
    const db = new Database(store.path, { readonly: true });
    const rows = db
      .prepare("SELECT role, content FROM messages ORDER BY id")
      .all() as Array<{ role: string; content: string }>;
    db.close();

    const assistants = rows.filter((r) => r.role === "assistant").map((r) => r.content);
    expect(assistants).toContain("Looking that up now.");
    expect(assistants).toContain("All set.");
    expect(assistants).not.toContain("(tool use)");
  });

  it("stores an empty string when a tool_use round has no narration (no sentinel)", async () => {
    const benign: Skill<{ x: number }> = {
      name: "benign",
      description: "no-op",
      parameters: z.object({ x: z.number() }),
      execute: ({ x }) => ok(`ran ${x}`),
    };
    const registry = new SkillRegistry();
    registry.register(benign);

    const llm = new ScriptedLLM([
      {
        kind: "tool_use",
        text: "",
        toolCalls: [{ id: "c1", name: "benign", args: { x: 1 } }],
      },
      { kind: "final", text: "done" },
    ]);

    const agent = buildAgent(store, llm, registry);
    await agent.runTurn("go");

    const db = new Database(store.path, { readonly: true });
    const rows = db
      .prepare("SELECT role, content FROM messages ORDER BY id")
      .all() as Array<{ role: string; content: string }>;
    db.close();

    const assistants = rows.filter((r) => r.role === "assistant").map((r) => r.content);
    // First assistant row from the tool_use round is empty, not "(tool use)".
    expect(assistants[0]).toBe("");
    expect(assistants).not.toContain("(tool use)");
  });
});

describe("Agent — intermediate text hook", () => {
  let dir: string;
  let store: SqliteStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-intermediate-"));
    store = new SqliteStore(join(dir, "test.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("calls onIntermediateText with the model's narration from a tool_use round", async () => {
    const benign: Skill<{ x: number }> = {
      name: "benign",
      description: "no-op",
      parameters: z.object({ x: z.number() }),
      execute: ({ x }) => ok(`ran ${x}`),
    };
    const registry = new SkillRegistry();
    registry.register(benign);

    const llm = new ScriptedLLM([
      {
        kind: "tool_use",
        text: "Checking that for you.",
        toolCalls: [{ id: "c1", name: "benign", args: { x: 1 } }],
      },
      { kind: "final", text: "Done." },
    ]);

    const agent = buildAgent(store, llm, registry);
    const onIntermediateText = vi.fn();
    const trace = await agent.runTurn("please", { onIntermediateText });

    expect(onIntermediateText).toHaveBeenCalledTimes(1);
    expect(onIntermediateText).toHaveBeenCalledWith("Checking that for you.");
    expect(trace.finalText).toBe("Done.");
  });

  it("does NOT call onIntermediateText when the round has no narration", async () => {
    const benign: Skill<{ x: number }> = {
      name: "benign",
      description: "no-op",
      parameters: z.object({ x: z.number() }),
      execute: ({ x }) => ok(`ran ${x}`),
    };
    const registry = new SkillRegistry();
    registry.register(benign);

    const llm = new ScriptedLLM([
      { kind: "tool_use", text: "", toolCalls: [{ id: "c1", name: "benign", args: { x: 1 } }] },
      { kind: "final", text: "fine" },
    ]);

    const agent = buildAgent(store, llm, registry);
    const onIntermediateText = vi.fn();
    await agent.runTurn("go", { onIntermediateText });

    expect(onIntermediateText).not.toHaveBeenCalled();
  });
});

describe("Agent — streaming token hook", () => {
  let dir: string;
  let store: SqliteStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-stream-"));
    store = new SqliteStore(join(dir, "test.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("forwards onAssistantToken to the provider's chat({ onToken }) and surfaces deltas", async () => {
    const registry = new SkillRegistry();
    const llm = new StreamingLLM([
      { chunks: ["Hel", "lo, ", "wor", "ld"], turn: { kind: "final", text: "Hello, world" } },
    ]);

    const agent = buildAgent(store, llm, registry);
    const deltas: string[] = [];
    const trace = await agent.runTurn("hi", {
      onAssistantToken: (d) => deltas.push(d),
    });

    expect(deltas).toEqual(["Hel", "lo, ", "wor", "ld"]);
    expect(deltas.join("")).toBe(trace.finalText);
  });

  it("streams across multiple rounds (tool_use → final)", async () => {
    const benign: Skill<{ x: number }> = {
      name: "benign",
      description: "no-op",
      parameters: z.object({ x: z.number() }),
      execute: ({ x }) => ok(`ran ${x}`),
    };
    const registry = new SkillRegistry();
    registry.register(benign);

    const llm = new StreamingLLM([
      {
        chunks: ["check", "ing…"],
        turn: {
          kind: "tool_use",
          text: "checking…",
          toolCalls: [{ id: "c1", name: "benign", args: { x: 1 } }],
        },
      },
      { chunks: ["done"], turn: { kind: "final", text: "done" } },
    ]);

    const agent = buildAgent(store, llm, registry);
    const deltas: string[] = [];
    await agent.runTurn("go", { onAssistantToken: (d) => deltas.push(d) });

    // Both rounds streamed their chunks in order.
    expect(deltas).toEqual(["check", "ing…", "done"]);
  });

  it("provider receives no onToken when the hook is omitted", async () => {
    const registry = new SkillRegistry();
    const llm = new ScriptedLLM([{ kind: "final", text: "x" }]);
    const agent = buildAgent(store, llm, registry);

    await agent.runTurn("hi"); // no hooks at all
    expect(llm.calls[0]?.onToken).toBeUndefined();
  });
});

describe("Agent — multi-tool-call in a single round", () => {
  let dir: string;
  let store: SqliteStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-multi-"));
    store = new SqliteStore(join(dir, "test.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs every tool call from one tool_use turn and bundles their results", async () => {
    const tool: Skill<{ x: number }> = {
      name: "add_one",
      description: "adds one",
      parameters: z.object({ x: z.number() }),
      execute: ({ x }) => ok(`x+1=${x + 1}`),
    };
    const registry = new SkillRegistry();
    registry.register(tool);

    const llm = new ScriptedLLM([
      {
        kind: "tool_use",
        text: "running three at once",
        toolCalls: [
          { id: "a", name: "add_one", args: { x: 1 } },
          { id: "b", name: "add_one", args: { x: 10 } },
          { id: "c", name: "add_one", args: { x: 100 } },
        ],
      },
      { kind: "final", text: "all done" },
    ]);

    const agent = buildAgent(store, llm, registry);
    const onTool = vi.fn();
    const trace = await agent.runTurn("do it", { onTool });

    // Trace records all three tool calls in order.
    expect(trace.toolCalls).toHaveLength(3);
    expect(trace.toolCalls.map((c) => c.output)).toEqual([
      "x+1=2",
      "x+1=11",
      "x+1=101",
    ]);
    expect(trace.toolCalls.every((c) => c.ok)).toBe(true);

    // onTool fired once per call in order.
    expect(onTool).toHaveBeenNthCalledWith(1, "add_one", { x: 1 });
    expect(onTool).toHaveBeenNthCalledWith(2, "add_one", { x: 10 });
    expect(onTool).toHaveBeenNthCalledWith(3, "add_one", { x: 100 });

    // The audit_log has a row per tool call, all successful.
    const db = new Database(store.path, { readonly: true });
    const rows = db
      .prepare("SELECT ok, args_json FROM audit_log WHERE skill='add_one' ORDER BY id")
      .all() as Array<{ ok: number; args_json: string }>;
    db.close();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.ok === 1)).toBe(true);
    expect(rows.map((r) => JSON.parse(r.args_json).x)).toEqual([1, 10, 100]);
  });

  it("continues after one of the calls fails (mixed ok/fail in the same round)", async () => {
    const tool: Skill<{ x: number; fail?: boolean }> = {
      name: "maybe_fail",
      description: "succeeds unless fail=true",
      parameters: z.object({ x: z.number(), fail: z.boolean().optional() }),
      execute: ({ x, fail: f }) => (f ? fail(`refused ${x}`) : ok(`ok ${x}`)),
    };
    const registry = new SkillRegistry();
    registry.register(tool);

    const llm = new ScriptedLLM([
      {
        kind: "tool_use",
        text: "",
        toolCalls: [
          { id: "a", name: "maybe_fail", args: { x: 1 } },
          { id: "b", name: "maybe_fail", args: { x: 2, fail: true } },
          { id: "c", name: "maybe_fail", args: { x: 3 } },
        ],
      },
      { kind: "final", text: "mixed result" },
    ]);

    const agent = buildAgent(store, llm, registry);
    const trace = await agent.runTurn("try it");

    expect(trace.toolCalls.map((c) => c.ok)).toEqual([true, false, true]);
    expect(trace.toolCalls[1]!.output).toMatch(/refused 2/);
  });
});

describe("Agent — tool threw exception branch", () => {
  let dir: string;
  let store: SqliteStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-throw-"));
    store = new SqliteStore(join(dir, "test.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("catches a synchronous throw from skill.execute, records ok=false, and continues the turn", async () => {
    const throwing: Skill<{ x: number }> = {
      name: "blow_up",
      description: "always throws",
      parameters: z.object({ x: z.number() }),
      execute() {
        throw new Error("kaboom-sync");
      },
    };
    const registry = new SkillRegistry();
    registry.register(throwing);

    const llm = new ScriptedLLM([
      {
        kind: "tool_use",
        text: "",
        toolCalls: [{ id: "c1", name: "blow_up", args: { x: 1 } }],
      },
      { kind: "final", text: "couldn't run that" },
    ]);

    const agent = buildAgent(store, llm, registry);
    const trace = await agent.runTurn("attempt");

    expect(trace.toolCalls).toHaveLength(1);
    expect(trace.toolCalls[0]!.ok).toBe(false);
    expect(trace.toolCalls[0]!.output).toMatch(/^tool threw: kaboom-sync$/);
    expect(trace.finalText).toBe("couldn't run that");

    // Audit row records the failure.
    const db = new Database(store.path, { readonly: true });
    const row = db
      .prepare("SELECT ok, result_summary FROM audit_log WHERE skill='blow_up'")
      .get() as { ok: number; result_summary: string };
    db.close();
    expect(row.ok).toBe(0);
    expect(row.result_summary).toMatch(/tool threw: kaboom-sync/);
  });

  it("catches an async rejection from skill.execute and treats it the same", async () => {
    const throwing: Skill<{ x: number }> = {
      name: "blow_up",
      description: "rejects",
      parameters: z.object({ x: z.number() }),
      async execute() {
        throw new Error("kaboom-async");
      },
    };
    const registry = new SkillRegistry();
    registry.register(throwing);

    const llm = new ScriptedLLM([
      {
        kind: "tool_use",
        text: "",
        toolCalls: [{ id: "c1", name: "blow_up", args: { x: 1 } }],
      },
      { kind: "final", text: "moving on" },
    ]);

    const agent = buildAgent(store, llm, registry);
    const trace = await agent.runTurn("try");

    expect(trace.toolCalls[0]!.ok).toBe(false);
    expect(trace.toolCalls[0]!.output).toMatch(/^tool threw: kaboom-async$/);
    expect(trace.finalText).toBe("moving on");
  });

  it("the next tool in the same round still runs after a sibling throws", async () => {
    const mixed: Skill<{ tag: string }> = {
      name: "mixed",
      description: "fails when tag='boom'",
      parameters: z.object({ tag: z.string() }),
      execute({ tag }) {
        if (tag === "boom") throw new Error("kaboom");
        return ok(`survived: ${tag}`);
      },
    };
    const registry = new SkillRegistry();
    registry.register(mixed);

    const llm = new ScriptedLLM([
      {
        kind: "tool_use",
        text: "",
        toolCalls: [
          { id: "a", name: "mixed", args: { tag: "ok-a" } },
          { id: "b", name: "mixed", args: { tag: "boom" } },
          { id: "c", name: "mixed", args: { tag: "ok-c" } },
        ],
      },
      { kind: "final", text: "fin" },
    ]);

    const agent = buildAgent(store, llm, registry);
    const trace = await agent.runTurn("go");

    expect(trace.toolCalls.map((c) => c.ok)).toEqual([true, false, true]);
    expect(trace.toolCalls[0]!.output).toMatch(/survived: ok-a/);
    expect(trace.toolCalls[1]!.output).toMatch(/^tool threw: kaboom$/);
    expect(trace.toolCalls[2]!.output).toMatch(/survived: ok-c/);
  });
});
