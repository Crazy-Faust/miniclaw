import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type AssistantTurn,
  type LLMProvider,
  type Message,
  SkillRegistry,
  type ToolSpec,
} from "@miniclaw/core";
import { WindowedContextManager } from "@miniclaw/context-windowed";
import { SqliteStore } from "@miniclaw/memory-sqlite";
import { sqlQuerySkill } from "@miniclaw/skills-db";
import { searchMemorySkill, writeMemorySkill } from "@miniclaw/skills-memory";
import { shellSkill } from "@miniclaw/skills-shell";

import { Agent } from "../src/index.ts";

// A FakeLLM that records every chat() invocation so tests can assert what
// the model actually received (e.g. retrieved memory in the system prompt).
class RecordingFakeLLM implements LLMProvider {
  calls: Array<{ system: string; messages: Message[]; tools: ToolSpec[] }> = [];
  private idx = 0;
  constructor(private readonly turns: AssistantTurn[]) {}
  async chat(opts: { system: string; messages: Message[]; tools: ToolSpec[] }) {
    this.calls.push(opts);
    const t = this.turns[this.idx++];
    if (!t) throw new Error("RecordingFakeLLM ran out of scripted turns");
    return t;
  }
}

function buildAgent(store: SqliteStore, llm: LLMProvider) {
  const registry = new SkillRegistry();
  registry.register(writeMemorySkill);
  registry.register(searchMemorySkill);
  registry.register(shellSkill);
  registry.register(sqlQuerySkill);
  const convId = store.newConversation();
  const context = new WindowedContextManager({
    memory: store, conversations: store, conversationId: convId,
  });
  const agent = new Agent({
    llm, registry, context, memory: store, audit: store, dbPath: store.path,
  });
  return { agent, registry, convId };
}

describe("Agent integration (real wiring across packages)", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-agent-int-"));
    store = new SqliteStore(join(dir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("recalls a memory written in a prior turn via the retrieved-memory system-prompt injection", async () => {
    // Choose terms that FTS5 will actually tokenize-match in the follow-up
    // ("helix" appears in both the stored memory and the recall query).
    const llm = new RecordingFakeLLM([
      // Turn 1: write the memory and answer.
      {
        kind: "tool_use",
        text: "",
        toolCalls: [
          {
            id: "w1",
            name: "write_memory",
            args: {
              content: "user prefers the helix editor",
              kind: "preference",
              tags: ["editor"],
            },
          },
        ],
      },
      { kind: "final", text: "Got it." },
      // Turn 2: the question shares the "helix" token with the stored memory,
      // so retrieval should kick in.
      { kind: "final", text: "You use helix." },
    ]);
    const { agent } = buildAgent(store, llm);

    await agent.runTurn("remember I prefer helix");
    const trace = await agent.runTurn("what helix editor do I prefer?");

    expect(trace.finalText).toMatch(/helix/i);
    // The 2nd-turn LLM call should have the memory injected into system.
    const turn2 = llm.calls.at(-1)!;
    expect(turn2.system).toMatch(/Relevant memories/);
    expect(turn2.system).toContain("user prefers the helix editor");
  });

  it("runs the shell skill and writes a successful audit_log row", async () => {
    const llm = new RecordingFakeLLM([
      {
        kind: "tool_use",
        text: "",
        toolCalls: [
          { id: "s1", name: "shell", args: { bin: "echo", args: ["integration-ok"] } },
        ],
      },
      { kind: "final", text: "Done." },
    ]);
    const { agent } = buildAgent(store, llm);

    const trace = await agent.runTurn("echo for me");
    expect(trace.toolCalls[0]!.name).toBe("shell");
    expect(trace.toolCalls[0]!.ok).toBe(true);
    expect(trace.toolCalls[0]!.output).toContain("integration-ok");

    // Inspect the audit log directly through a fresh readonly handle.
    const db = new Database(store.path, { readonly: true });
    const rows = db
      .prepare("SELECT skill, ok FROM audit_log WHERE skill='shell'")
      .all() as Array<{ skill: string; ok: number }>;
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ok).toBe(1);
  });

  it("blocks a disallowed shell command and records the failure in audit_log", async () => {
    const llm = new RecordingFakeLLM([
      {
        kind: "tool_use",
        text: "",
        toolCalls: [{ id: "s1", name: "shell", args: { bin: "rm", args: ["-rf", "/"] } }],
      },
      { kind: "final", text: "I couldn't run that." },
    ]);
    const { agent } = buildAgent(store, llm);

    const trace = await agent.runTurn("delete everything");
    expect(trace.toolCalls[0]!.ok).toBe(false);
    expect(trace.toolCalls[0]!.output).toMatch(/refused/);

    const db = new Database(store.path, { readonly: true });
    const row = db
      .prepare("SELECT ok, result_summary FROM audit_log WHERE skill='shell'")
      .get() as { ok: number; result_summary: string };
    db.close();
    expect(row.ok).toBe(0);
    expect(row.result_summary).toMatch(/refused/);
  });

  it("queries prior memories via the sql_query skill", async () => {
    // Seed a memory directly so the test is deterministic.
    store.add("fact", "agent integration test note", ["it"]);

    const llm = new RecordingFakeLLM([
      {
        kind: "tool_use",
        text: "",
        toolCalls: [
          {
            id: "q1",
            name: "sql_query",
            args: { sql: "SELECT COUNT(*) AS n FROM memories", limit: 50 },
          },
        ],
      },
      { kind: "final", text: "There is 1 memory." },
    ]);
    const { agent } = buildAgent(store, llm);

    const trace = await agent.runTurn("how many memories?");
    expect(trace.toolCalls[0]!.name).toBe("sql_query");
    expect(trace.toolCalls[0]!.output).toMatch(/"n": ?1/);
    expect(trace.finalText).toMatch(/1 memory/);
  });

  it("sends the tool's stdout back to the LLM as a tool-results message", async () => {
    const llm = new RecordingFakeLLM([
      {
        kind: "tool_use",
        text: "",
        toolCalls: [
          { id: "s1", name: "shell", args: { bin: "echo", args: ["payload-token"] } },
        ],
      },
      { kind: "final", text: "saw it." },
    ]);
    const { agent } = buildAgent(store, llm);
    await agent.runTurn("run echo");

    // The 2nd LLM call (after the tool ran) should include a tool-results
    // message containing the stdout.
    const followup = llm.calls[1]!;
    const last = followup.messages.at(-1)!;
    expect(last.role).toBe("tool");
    if (last.role === "tool") {
      expect(last.results).toHaveLength(1);
      expect(last.results[0]!.content).toContain("payload-token");
      expect(last.results[0]!.isError).toBe(false);
      expect(last.results[0]!.toolName).toBe("shell");
    }
  });
});
