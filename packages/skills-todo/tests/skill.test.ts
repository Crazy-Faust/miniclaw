import { describe, expect, it } from "vitest";
import type { SkillContext } from "@miniclaw/core";
import {
  createTodosCommand,
  createTodoWriteSkill,
  InMemoryTodoStore,
} from "../src/index.ts";

const stubCtx: SkillContext = {
  memory: { add: () => 0, search: () => [], listRecent: () => [] },
  audit: { logToolCall: () => {} },
  dbPath: "/dev/null",
};

describe("createTodoWriteSkill", () => {
  it("writes a plan and returns it wrapped in <tool_output>", async () => {
    const store = new InMemoryTodoStore();
    const skill = createTodoWriteSkill(store);
    const res = await skill.execute(
      {
        items: [
          { content: "first step", status: "in_progress" },
          { content: "second step", status: "pending" },
        ],
      },
      stubCtx,
    );
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/plan updated; 2 items total/);
    expect(res.output).toMatch(/<tool_output>[\s\S]*first step[\s\S]*<\/tool_output>/);
    expect(store.list()).toHaveLength(2);
  });

  it("rejects an empty content string at the zod layer", () => {
    const store = new InMemoryTodoStore();
    const skill = createTodoWriteSkill(store);
    const parsed = skill.parameters.safeParse({ items: [{ content: "", status: "pending" }] });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unrecognized status", () => {
    const store = new InMemoryTodoStore();
    const skill = createTodoWriteSkill(store);
    const parsed = skill.parameters.safeParse({
      items: [{ content: "x", status: "blocked" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a plan with > 50 items (guards against runaway generation)", () => {
    const skill = createTodoWriteSkill(new InMemoryTodoStore());
    const items = Array.from({ length: 51 }, (_, i) => ({ content: `i${i}`, status: "pending" as const }));
    const parsed = skill.parameters.safeParse({ items });
    expect(parsed.success).toBe(false);
  });

  it("subsequent calls REPLACE the plan (not merge)", async () => {
    const store = new InMemoryTodoStore();
    const skill = createTodoWriteSkill(store);
    await skill.execute(
      { items: [{ content: "a", status: "pending" }, { content: "b", status: "pending" }] },
      stubCtx,
    );
    await skill.execute(
      { items: [{ id: 1, content: "a", status: "completed" }] },
      stubCtx,
    );
    expect(store.list().map((i) => i.id)).toEqual([1]);
  });
});

describe("createTodosCommand", () => {
  it("'/todos' renders the current plan", async () => {
    const store = new InMemoryTodoStore();
    store.replace([
      { content: "investigate cache", status: "in_progress" },
      { content: "write the test", status: "pending" },
    ]);
    const outputs: string[] = [];
    const cmd = createTodosCommand(store);
    await cmd.run("/todos", { io: { write: (t) => outputs.push(t) } });
    const text = outputs.join("");
    expect(text).toContain("investigate cache");
    expect(text).toContain("write the test");
    expect(text).toContain("[~]"); // in_progress marker
  });

  it("'/todos clear' resets the plan", async () => {
    const store = new InMemoryTodoStore();
    store.replace([{ content: "x", status: "pending" }]);
    const outputs: string[] = [];
    const cmd = createTodosCommand(store);
    await cmd.run("/todos clear", { io: { write: (t) => outputs.push(t) } });
    expect(store.list()).toEqual([]);
    expect(outputs.join("")).toMatch(/cleared/);
  });

  it("matches() rejects unrelated input", () => {
    const cmd = createTodosCommand(new InMemoryTodoStore());
    expect(cmd.matches("/todos")).toBe(true);
    expect(cmd.matches("/todos clear")).toBe(true);
    expect(cmd.matches("/todos something-else")).toBe(false);
    expect(cmd.matches("hello")).toBe(false);
  });
});
