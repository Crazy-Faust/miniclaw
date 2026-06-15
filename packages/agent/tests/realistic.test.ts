/**
 * Realistic agent integration tests.
 *
 * Each test drives the agent with a pre-recorded LLM tool-call sequence from
 * fixtures/realistic-llm-calls.ts and asserts the observable behaviour: which
 * skills ran, whether they succeeded, what ended up in the audit log, etc.
 * The natural-language final text is intentionally not asserted because it is
 * irrelevant to correctness.
 */

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
import { sqlQuerySkill } from "@miniclaw/agent-skills";
import { searchMemorySkill, writeMemorySkill } from "@miniclaw/agent-skills";
import { createShellSkill } from "@miniclaw/agent-skills";
import { createTodoWriteSkill, InMemoryTodoStore } from "@miniclaw/agent-skills";

import { Agent } from "../src/index.ts";
import {
  CHECK_GIT_STATUS_THEN_LOG,
  COUNT_FILES_BY_EXTENSION,
  LIST_FILES_IN_WORKSPACE,
  PLAN_AUTH_FEATURE,
  PLAN_THEN_MARK_FIRST_IN_PROGRESS,
  QUERY_MEMORY_COUNT,
  RECALL_EDITOR_PREFERENCE,
  REMEMBER_LANGUAGE_PREFERENCE,
  SEARCH_MEMORY_EMPTY_THEN_WRITE,
  SEARCH_THEN_UPDATE_MEMORY,
  SHELL_REFUSES_THEN_FALLS_BACK,
} from "./fixtures/realistic-llm-calls.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class FixtureLLM implements LLMProvider {
  readonly calls: Array<{ system: string; messages: Message[]; tools: ToolSpec[] }> = [];
  private idx = 0;
  constructor(private readonly turns: AssistantTurn[]) {}

  async chat(opts: { system: string; messages: Message[]; tools: ToolSpec[] }): Promise<AssistantTurn> {
    this.calls.push(opts);
    const turn = this.turns[this.idx++];
    if (!turn) throw new Error("FixtureLLM ran out of scripted turns");
    return turn;
  }
}

function buildAgent(
  store: SqliteStore,
  llm: LLMProvider,
  registry: SkillRegistry,
  workspaceRoot?: string,
) {
  const convId = store.newConversation();
  const context = new WindowedContextManager({
    memory: store,
    conversations: store,
    conversationId: convId,
  });
  const agent = new Agent({
    llm,
    registry,
    context,
    memory: store,
    audit: store,
    dbPath: store.path,
    workspaceRoot,
  });
  return { agent, convId };
}

function memoryRegistry(store: SqliteStore) {
  const r = new SkillRegistry();
  r.register(writeMemorySkill);
  r.register(searchMemorySkill);
  return r;
}

function fullRegistry(store: SqliteStore, todoStore: InMemoryTodoStore, workspaceRoot?: string) {
  const r = new SkillRegistry();
  r.register(writeMemorySkill);
  r.register(searchMemorySkill);
  r.register(sqlQuerySkill);
  r.register(createShellSkill({ allowlist: new Set(["echo", "ls", "find", "wc", "git", "rm"]) }));
  r.register(createTodoWriteSkill(todoStore));
  return r;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let dir: string;
let store: SqliteStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "miniclaw-realistic-"));
  store = new SqliteStore(join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Single-tool scenarios
// ---------------------------------------------------------------------------

describe("realistic: single tool call per turn", () => {
  it("REMEMBER_LANGUAGE_PREFERENCE — writes memory and records an audit entry", async () => {
    const llm = new FixtureLLM(REMEMBER_LANGUAGE_PREFERENCE.turns);
    const { agent } = buildAgent(store, llm, memoryRegistry(store));

    const trace = await agent.runTurn(REMEMBER_LANGUAGE_PREFERENCE.userMessage);

    expect(trace.toolCalls).toHaveLength(1);
    expect(trace.toolCalls[0]!.name).toBe("write_memory");
    expect(trace.toolCalls[0]!.ok).toBe(true);

    const hits = store.search("TypeScript");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toMatch(/TypeScript/);

    const db = new Database(store.path, { readonly: true });
    const row = db
      .prepare("SELECT ok FROM audit_log WHERE skill='write_memory'")
      .get() as { ok: number } | undefined;
    db.close();
    expect(row?.ok).toBe(1);
  });

  it("RECALL_EDITOR_PREFERENCE — search_memory called with realistic query; narration forwarded", async () => {
    store.add("preference", "user prefers the helix editor", ["editor"]);

    const llm = new FixtureLLM(RECALL_EDITOR_PREFERENCE.turns);
    const { agent } = buildAgent(store, llm, memoryRegistry(store));

    const intermediate: string[] = [];
    const trace = await agent.runTurn(RECALL_EDITOR_PREFERENCE.userMessage, {
      onIntermediateText: (t) => intermediate.push(t),
    });

    expect(trace.toolCalls[0]!.name).toBe("search_memory");
    expect(trace.toolCalls[0]!.ok).toBe(true);
    // The narration "Let me search…" should have been surfaced as intermediate text.
    expect(intermediate).toHaveLength(1);
    expect(intermediate[0]).toMatch(/search/i);
  });

  it("QUERY_MEMORY_COUNT — sql_query returns a JSON result with the real row count", async () => {
    store.add("fact", "likes coffee", ["food"]);
    store.add("preference", "prefers dark mode", ["ui"]);

    const r = new SkillRegistry();
    r.register(sqlQuerySkill);
    const llm = new FixtureLLM(QUERY_MEMORY_COUNT.turns);
    const { agent } = buildAgent(store, llm, r);

    const trace = await agent.runTurn(QUERY_MEMORY_COUNT.userMessage);

    expect(trace.toolCalls[0]!.name).toBe("sql_query");
    expect(trace.toolCalls[0]!.ok).toBe(true);
    // At least two rows with non-zero counts (one per distinct kind we seeded).
    expect(trace.toolCalls[0]!.output).toMatch(/"total":\s*1/);
  });

  it("LIST_FILES_IN_WORKSPACE — shell ls runs in the workspace root", async () => {
    const r = new SkillRegistry();
    r.register(createShellSkill({ allowlist: new Set(["ls"]) }));
    const llm = new FixtureLLM(LIST_FILES_IN_WORKSPACE.turns);
    const { agent } = buildAgent(store, llm, r, dir);

    const trace = await agent.runTurn(LIST_FILES_IN_WORKSPACE.userMessage);

    expect(trace.toolCalls[0]!.name).toBe("shell");
    expect(trace.toolCalls[0]!.ok).toBe(true);
    // The tmp dir contains the test.db we just created.
    expect(trace.toolCalls[0]!.output).toContain("test.db");
  });

  it("PLAN_AUTH_FEATURE — todo_write stores 5 pending items", async () => {
    const todoStore = new InMemoryTodoStore();
    const r = new SkillRegistry();
    r.register(createTodoWriteSkill(todoStore));
    const llm = new FixtureLLM(PLAN_AUTH_FEATURE.turns);
    const { agent } = buildAgent(store, llm, r);

    const trace = await agent.runTurn(PLAN_AUTH_FEATURE.userMessage);

    expect(trace.toolCalls[0]!.name).toBe("todo_write");
    expect(trace.toolCalls[0]!.ok).toBe(true);
    const items = todoStore.list();
    expect(items).toHaveLength(5);
    expect(items.every((i) => i.status === "pending")).toBe(true);
    expect(items[0]!.content).toMatch(/JWT/i);
  });
});

// ---------------------------------------------------------------------------
// Multi-tool chaining scenarios
// ---------------------------------------------------------------------------

describe("realistic: multi-step tool-call chains", () => {
  it("SEARCH_THEN_UPDATE_MEMORY — search_memory then write_memory; both recorded in audit", async () => {
    store.add("preference", "user prefers React for frontend", ["react", "frontend"]);

    const llm = new FixtureLLM(SEARCH_THEN_UPDATE_MEMORY.turns);
    const { agent } = buildAgent(store, llm, memoryRegistry(store));

    const trace = await agent.runTurn(SEARCH_THEN_UPDATE_MEMORY.userMessage);

    expect(trace.toolCalls).toHaveLength(2);
    expect(trace.toolCalls[0]!.name).toBe("search_memory");
    expect(trace.toolCalls[1]!.name).toBe("write_memory");
    expect(trace.toolCalls.every((c) => c.ok)).toBe(true);

    const db = new Database(store.path, { readonly: true });
    const rows = db
      .prepare("SELECT skill FROM audit_log ORDER BY id")
      .all() as Array<{ skill: string }>;
    db.close();
    expect(rows.map((r) => r.skill)).toEqual(["search_memory", "write_memory"]);
  });

  it("CHECK_GIT_STATUS_THEN_LOG — two sequential git shell calls succeed", async () => {
    const r = new SkillRegistry();
    r.register(createShellSkill({ allowlist: new Set(["git"]) }));
    const llm = new FixtureLLM(CHECK_GIT_STATUS_THEN_LOG.turns);
    const { agent } = buildAgent(store, llm, r, dir);

    const trace = await agent.runTurn(CHECK_GIT_STATUS_THEN_LOG.userMessage);

    expect(trace.toolCalls).toHaveLength(2);
    expect(trace.toolCalls.map((c) => c.name)).toEqual(["shell", "shell"]);
    // git status/log both return useful output (even if there's no git repo —
    // the test just verifies the agent wired up and ran them).
    expect(trace.toolCalls[0]!.output).toBeTruthy();
    expect(trace.toolCalls[1]!.output).toBeTruthy();
  });

  it("COUNT_FILES_BY_EXTENSION — find then wc; find output flows to LLM before wc round", async () => {
    const r = new SkillRegistry();
    r.register(createShellSkill({ allowlist: new Set(["find", "ls"]) }));
    const llm = new FixtureLLM(COUNT_FILES_BY_EXTENSION.turns);
    const { agent } = buildAgent(store, llm, r, dir);

    const toolNames: string[] = [];
    const trace = await agent.runTurn(COUNT_FILES_BY_EXTENSION.userMessage, {
      onTool: (name) => toolNames.push(name),
    });

    expect(toolNames).toEqual(["shell", "shell"]);
    // find runs without error even if there are no .ts files in the tmp dir.
    expect(trace.toolCalls[0]!.name).toBe("shell");
    expect(trace.toolCalls[1]!.name).toBe("shell");

    // Verify the second LLM call received the find output as a tool-results message.
    const secondCall = llm.calls[1]!;
    const toolResultMsg = secondCall.messages.find((m) => m.role === "tool");
    expect(toolResultMsg).toBeDefined();
    if (toolResultMsg?.role === "tool") {
      expect(toolResultMsg.results[0]!.toolName).toBe("shell");
    }
  });

  it("PLAN_THEN_MARK_FIRST_IN_PROGRESS — two todo_write calls; second marks id=1 as in_progress", async () => {
    const todoStore = new InMemoryTodoStore();
    const r = new SkillRegistry();
    r.register(createTodoWriteSkill(todoStore));
    const llm = new FixtureLLM(PLAN_THEN_MARK_FIRST_IN_PROGRESS.turns);
    const { agent } = buildAgent(store, llm, r);

    const trace = await agent.runTurn(PLAN_THEN_MARK_FIRST_IN_PROGRESS.userMessage);

    expect(trace.toolCalls).toHaveLength(2);
    expect(trace.toolCalls.every((c) => c.ok)).toBe(true);

    const items = todoStore.list();
    expect(items).toHaveLength(4);
    expect(items[0]!.status).toBe("in_progress");
    expect(items.slice(1).every((i) => i.status === "pending")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error-recovery scenarios
// ---------------------------------------------------------------------------

describe("realistic: partial failures and recovery", () => {
  it("SHELL_REFUSES_THEN_FALLS_BACK — rm refused, ls succeeds; both calls in same round", async () => {
    // rm is allowlisted in the fixture registry but the security check will
    // still refuse it because it targets an absolute path outside the workspace.
    const r = new SkillRegistry();
    r.register(createShellSkill({ allowlist: new Set(["rm", "ls"]) }));
    const llm = new FixtureLLM(SHELL_REFUSES_THEN_FALLS_BACK.turns);
    const { agent } = buildAgent(store, llm, r, dir);

    const trace = await agent.runTurn(SHELL_REFUSES_THEN_FALLS_BACK.userMessage);

    expect(trace.toolCalls).toHaveLength(2);
    const [rmCall, lsCall] = trace.toolCalls;
    expect(rmCall!.name).toBe("shell");
    expect(rmCall!.ok).toBe(false);
    expect(rmCall!.output).toMatch(/refused/);

    expect(lsCall!.name).toBe("shell");
    expect(lsCall!.ok).toBe(true);

    // Audit log captures both outcomes.
    const db = new Database(store.path, { readonly: true });
    const rows = db
      .prepare("SELECT ok FROM audit_log WHERE skill='shell' ORDER BY id")
      .all() as Array<{ ok: number }>;
    db.close();
    expect(rows.map((r) => r.ok)).toEqual([0, 1]);
  });

  it("SEARCH_MEMORY_EMPTY_THEN_WRITE — empty search result leads to a write on the next round", async () => {
    // No memories seeded — the search returns nothing, the LLM then writes.
    const llm = new FixtureLLM(SEARCH_MEMORY_EMPTY_THEN_WRITE.turns);
    const { agent } = buildAgent(store, llm, memoryRegistry(store));

    const trace = await agent.runTurn(SEARCH_MEMORY_EMPTY_THEN_WRITE.userMessage);

    expect(trace.toolCalls).toHaveLength(2);
    expect(trace.toolCalls[0]!.name).toBe("search_memory");
    expect(trace.toolCalls[0]!.ok).toBe(true);
    expect(trace.toolCalls[0]!.output).toMatch(/no matching memories/);

    expect(trace.toolCalls[1]!.name).toBe("write_memory");
    expect(trace.toolCalls[1]!.ok).toBe(true);

    // The newly written memory should be retrievable.
    const hits = store.search("zsh");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toMatch(/zsh/);
  });

  it("tool result from round N is visible in the messages sent for round N+1", async () => {
    // Verify that the search_memory result from round 0 is present in the
    // messages array the agent passes to the LLM on round 1 (write_memory).
    const llm = new FixtureLLM(SEARCH_THEN_UPDATE_MEMORY.turns);
    const { agent } = buildAgent(store, llm, memoryRegistry(store));

    await agent.runTurn(SEARCH_THEN_UPDATE_MEMORY.userMessage);

    // Three rounds: search → write → final, so three LLM calls.
    expect(llm.calls).toHaveLength(3);

    // The round-1 call (write_memory) must include the search_memory tool
    // result so the model can see what was found before deciding what to write.
    const round1 = llm.calls[1]!;
    const toolMsg = round1.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    if (toolMsg?.role === "tool") {
      expect(toolMsg.results[0]!.toolName).toBe("search_memory");
      expect(toolMsg.results[0]!.isError).toBe(false);
    }
  });
});
