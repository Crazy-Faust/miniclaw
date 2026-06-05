import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Agent } from "@miniclaw/agent";
import { WindowedContextManager } from "@miniclaw/context-windowed";
import {
  type AssistantTurn,
  type LLMProvider,
  type Message,
  SkillRegistry,
  type ToolSpec,
} from "@miniclaw/core";
import { SqliteStore } from "@miniclaw/memory-sqlite";
import { searchMemorySkill, writeMemorySkill } from "@miniclaw/skills-memory";

import {
  exitCommand,
  Harness,
  type IOAdapter,
  memoriesCommand,
  skillsCommand,
} from "../src/index.ts";

// ---- Test helpers ----

class FakeIO implements IOAdapter {
  outputs: string[] = [];
  prompts: string[] = [];
  toolCalls: Array<{ name: string; args: unknown }> = [];
  closed = false;
  private readonly inputs: (string | null)[];

  constructor(inputs: (string | null)[]) {
    this.inputs = [...inputs];
  }
  async readLine(prompt: string): Promise<string | null> {
    this.prompts.push(prompt);
    if (this.inputs.length === 0) return null;
    return this.inputs.shift()!;
  }
  write(text: string): void { this.outputs.push(text); }
  onToolCall(name: string, args: unknown): void { this.toolCalls.push({ name, args }); }
  close(): void { this.closed = true; }
  get text(): string { return this.outputs.join(""); }
}

class FakeLLM implements LLMProvider {
  calls: Array<{ system: string; messages: Message[]; tools: ToolSpec[] }> = [];
  private idx = 0;
  constructor(private readonly turns: AssistantTurn[]) {}
  async chat(opts: { system: string; messages: Message[]; tools: ToolSpec[] }) {
    this.calls.push(opts);
    const t = this.turns[this.idx++];
    if (!t) throw new Error("FakeLLM ran out of scripted turns");
    return t;
  }
}

function buildAgent(store: SqliteStore, llm: LLMProvider) {
  const registry = new SkillRegistry();
  registry.register(writeMemorySkill);
  registry.register(searchMemorySkill);
  const convId = store.newConversation();
  const context = new WindowedContextManager({
    memory: store, conversations: store, conversationId: convId,
  });
  const agent = new Agent({
    llm, registry, context, memory: store, audit: store, dbPath: store.path,
  });
  return { agent, registry };
}

// ---- Tests ----

describe("Harness", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-harness-"));
    store = new SqliteStore(join(dir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints the banner once at startup and closes the IO at end of session", async () => {
    const io = new FakeIO([null]); // immediate EOF
    const llm = new FakeLLM([]);
    const { agent } = buildAgent(store, llm);

    const harness = new Harness({ agent, io, banner: "welcome" });
    await harness.run();

    expect(io.outputs[0]).toBe("welcome\n");
    expect(io.closed).toBe(true);
    expect(io.prompts).toEqual(["> "]); // prompted once before EOF
  });

  it("runs an agent turn for non-command input and writes the final text", async () => {
    const io = new FakeIO(["hello", null]);
    const llm = new FakeLLM([{ kind: "final", text: "hi there" }]);
    const { agent } = buildAgent(store, llm);

    const harness = new Harness({ agent, io });
    await harness.run();

    expect(io.text).toContain("hi there");
    expect(llm.calls).toHaveLength(1);
  });

  it("notifies the IO adapter of each tool call before agent emits text", async () => {
    const io = new FakeIO(["please remember stuff", null]);
    const llm = new FakeLLM([
      {
        kind: "tool_use",
        text: "",
        toolCalls: [{ id: "c1", name: "write_memory", args: { content: "x" } }],
      },
      { kind: "final", text: "ok." },
    ]);
    const { agent } = buildAgent(store, llm);

    await new Harness({ agent, io }).run();

    expect(io.toolCalls).toEqual([{ name: "write_memory", args: { content: "x" } }]);
    expect(io.text).toContain("ok.");
  });

  it("skips empty lines without invoking the agent", async () => {
    const io = new FakeIO(["", "   ", "hi", null]);
    const llm = new FakeLLM([{ kind: "final", text: "yes" }]);
    const { agent } = buildAgent(store, llm);

    await new Harness({ agent, io }).run();

    // FakeLLM only called once → confirms blank lines didn't trigger turns.
    expect(llm.calls).toHaveLength(1);
    expect(io.prompts.length).toBe(4); // empty, empty, hi, EOF
  });

  it("/exit stops the loop without invoking the agent", async () => {
    const io = new FakeIO(["/exit", "this-would-be-a-turn"]);
    const llm = new FakeLLM([{ kind: "final", text: "should not run" }]);
    const { agent } = buildAgent(store, llm);

    await new Harness({ agent, io, metaCommands: [exitCommand()] }).run();

    expect(llm.calls).toHaveLength(0);
    expect(io.closed).toBe(true);
  });

  it("/skills lists registered skills via the skillsCommand", async () => {
    const io = new FakeIO(["/skills", null]);
    const llm = new FakeLLM([]);
    const { agent, registry } = buildAgent(store, llm);

    await new Harness({
      agent, io, metaCommands: [skillsCommand(registry)],
    }).run();

    expect(io.text).toContain("write_memory");
    expect(io.text).toContain("search_memory");
  });

  it("/memories shows a helpful message when the store is empty", async () => {
    const io = new FakeIO(["/memories", null]);
    const llm = new FakeLLM([]);
    const { agent } = buildAgent(store, llm);

    await new Harness({ agent, io, metaCommands: [memoriesCommand(store)] }).run();
    expect(io.text).toMatch(/no memories yet/);
  });

  it("/memories reads recent entries via the memoriesCommand", async () => {
    store.add("fact", "alpha", []);
    store.add("fact", "beta", ["b"]);

    const io = new FakeIO(["/memories 5", null]);
    const llm = new FakeLLM([]);
    const { agent } = buildAgent(store, llm);

    await new Harness({
      agent, io, metaCommands: [memoriesCommand(store)],
    }).run();

    expect(io.text).toContain("alpha");
    expect(io.text).toContain("beta");
  });

  it("/help auto-listing includes all meta commands (and itself)", async () => {
    const io = new FakeIO(["/help", null]);
    const llm = new FakeLLM([]);
    const { agent, registry } = buildAgent(store, llm);

    await new Harness({
      agent, io,
      metaCommands: [exitCommand(), skillsCommand(registry), memoriesCommand(store)],
    }).run();

    expect(io.text).toContain("/exit");
    expect(io.text).toContain("/skills");
    expect(io.text).toContain("/memories");
    expect(io.text).toContain("/help");
  });

  it("surfaces an agent error to the user without crashing the loop", async () => {
    const failingLLM: LLMProvider = {
      async chat() { throw new Error("upstream is down"); },
    };
    const { agent } = buildAgent(store, failingLLM);
    const io = new FakeIO(["do something", "more", null]);

    await new Harness({ agent, io }).run();

    expect(io.text).toContain("error: upstream is down");
    // After the error the loop continued to prompt again before EOF.
    expect(io.prompts.length).toBe(3);
  });

  it("treats EOF (readLine returning null) as a clean termination", async () => {
    const io = new FakeIO([null]);
    const llm = new FakeLLM([]);
    const { agent } = buildAgent(store, llm);

    await new Harness({ agent, io }).run();
    expect(io.closed).toBe(true);
  });

  it("evaluates meta commands in order — first match wins", async () => {
    const calls: string[] = [];
    const a = {
      name: "/x",
      description: "first",
      matches: (l: string) => l === "/x",
      run: () => { calls.push("a"); },
    };
    const b = {
      name: "/x",
      description: "second",
      matches: (l: string) => l === "/x",
      run: () => { calls.push("b"); },
    };

    const io = new FakeIO(["/x", null]);
    const llm = new FakeLLM([]);
    const { agent } = buildAgent(store, llm);

    await new Harness({ agent, io, metaCommands: [a, b] }).run();

    expect(calls).toEqual(["a"]);
  });
});
