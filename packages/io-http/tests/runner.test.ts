import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AssistantTurn,
  fail,
  type LLMProvider,
  ok,
  type Skill,
  SkillRegistry,
} from "@miniclaw/core";
import { Agent } from "@miniclaw/agent";
import { streamTurn } from "../src/index.ts";

// A streaming-capable fake LLM: emits chunks via opts.onToken before
// returning the pre-baked turn. Mirrors the agent-package test helper.
class StreamingLLM implements LLMProvider {
  private idx = 0;
  constructor(private readonly script: Array<{ chunks: string[]; turn: AssistantTurn }>) {}
  async chat(opts: { onToken?: (delta: string) => void }) {
    const step = this.script[this.idx++];
    if (!step) throw new Error("ran out of script");
    if (opts.onToken) for (const c of step.chunks) opts.onToken(c);
    return step.turn;
  }
}

// Minimal MemoryStore / AuditSink / ContextManager that satisfy the Agent
// without dragging in a SQLite dep.
function noOpDeps() {
  const memory = { add: () => 0, search: () => [], listRecent: () => [] };
  const audit = { logToolCall: () => {} };
  const context = {
    prepare: (m: string) => ({ system: "", messages: [{ role: "user" as const, content: m }] }),
    recordUser: () => {},
    recordAssistant: () => {},
  };
  return { memory, audit, context };
}

interface CapturedEvent { event: string; data: unknown }

function parseSse(text: string): CapturedEvent[] {
  const frames = text.split("\n\n").filter(Boolean);
  return frames.map((f) => {
    const lines = f.split("\n");
    const ev = lines.find((l) => l.startsWith("event: "))!.slice("event: ".length);
    const dataLines = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice("data: ".length));
    return { event: ev, data: JSON.parse(dataLines.join("\n")) };
  });
}

describe("streamTurn", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "miniclaw-http-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("streams token + final events for a plain-text turn", async () => {
    const { memory, audit, context } = noOpDeps();
    const llm = new StreamingLLM([
      { chunks: ["Hel", "lo, ", "world"], turn: { kind: "final", text: "Hello, world" } },
    ]);
    const agent = new Agent({
      llm, registry: new SkillRegistry(), context, memory, audit, dbPath: ":memory:",
    });

    let buf = "";
    let closed = false;
    await streamTurn(agent, "hi", { write: (c) => { buf += c; }, end: () => { closed = true; } });
    expect(closed).toBe(true);

    const events = parseSse(buf);
    const types = events.map((e) => e.event);
    expect(types).toEqual(["token", "token", "token", "final"]);
    expect(events.slice(0, 3).map((e) => (e.data as { delta: string }).delta)).toEqual([
      "Hel", "lo, ", "world",
    ]);
    expect((events.at(-1)!.data as { text: string }).text).toBe("Hello, world");
  });

  it("emits tool_call and tool_result events around each tool dispatch", async () => {
    const { memory, audit, context } = noOpDeps();
    const skill: Skill<{ x: number }> = {
      name: "echo_x",
      description: "echoes x",
      parameters: z.object({ x: z.number() }),
      execute({ x }) { return ok(`got ${x}`); },
    };
    const registry = new SkillRegistry();
    registry.register(skill);

    const llm = new StreamingLLM([
      {
        chunks: ["checking"],
        turn: {
          kind: "tool_use",
          text: "checking",
          toolCalls: [{ id: "c1", name: "echo_x", args: { x: 7 } }],
        },
      },
      { chunks: ["done"], turn: { kind: "final", text: "done" } },
    ]);
    const agent = new Agent({
      llm, registry, context, memory, audit, dbPath: ":memory:",
    });

    let buf = "";
    await streamTurn(agent, "go", { write: (c) => { buf += c; }, end: () => {} });

    const events = parseSse(buf);
    const types = events.map((e) => e.event);
    // Sequence: token (chunk), tool_call, tool_result, token (chunk), final
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    const toolCall = events.find((e) => e.event === "tool_call")!;
    expect(toolCall.data).toEqual({ name: "echo_x", args: { x: 7 } });
    const toolResult = events.find((e) => e.event === "tool_result")!;
    expect(toolResult.data).toMatchObject({ name: "echo_x", ok: true, output: "got 7" });
    const final = events.find((e) => e.event === "final")!;
    expect((final.data as { text: string }).text).toBe("done");
  });

  it("emits a tool_result with ok=false when a skill returns fail()", async () => {
    const { memory, audit, context } = noOpDeps();
    const skill: Skill<{ x: number }> = {
      name: "boom",
      description: "fails",
      parameters: z.object({ x: z.number() }),
      execute() { return fail("nope"); },
    };
    const registry = new SkillRegistry();
    registry.register(skill);

    const llm = new StreamingLLM([
      { chunks: [], turn: { kind: "tool_use", text: "", toolCalls: [{ id: "c1", name: "boom", args: { x: 1 } }] } },
      { chunks: [], turn: { kind: "final", text: "tried" } },
    ]);
    const agent = new Agent({ llm, registry, context, memory, audit, dbPath: ":memory:" });

    let buf = "";
    await streamTurn(agent, "go", { write: (c) => { buf += c; }, end: () => {} });

    const events = parseSse(buf);
    const tr = events.find((e) => e.event === "tool_result")!;
    expect(tr.data).toMatchObject({ ok: false, output: "nope" });
  });

  it("emits an `error` event (not a throw) when the agent rethrows a provider failure", async () => {
    const { memory, audit, context } = noOpDeps();
    const llm: LLMProvider = {
      async chat() { throw new Error("upstream dead"); },
    };
    const agent = new Agent({
      llm, registry: new SkillRegistry(), context, memory, audit, dbPath: ":memory:",
      retry: { maxAttempts: 1 },
    });

    let buf = "";
    let closed = false;
    await streamTurn(agent, "go", { write: (c) => { buf += c; }, end: () => { closed = true; } });
    expect(closed).toBe(true);
    const events = parseSse(buf);
    const err = events.find((e) => e.event === "error")!;
    expect((err.data as { message: string }).message).toMatch(/upstream dead/);
  });
});
