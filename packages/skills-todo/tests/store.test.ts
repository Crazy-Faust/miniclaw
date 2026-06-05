import { describe, expect, it } from "vitest";
import { formatTodos, InMemoryTodoStore } from "../src/index.ts";

describe("InMemoryTodoStore", () => {
  it("starts empty", () => {
    expect(new InMemoryTodoStore().list()).toEqual([]);
  });

  it("replace() appends items without ids and assigns monotonic ids", () => {
    const s = new InMemoryTodoStore();
    const r = s.replace([
      { content: "step one", status: "pending" },
      { content: "step two", status: "in_progress" },
    ]);
    expect(r).toHaveLength(2);
    expect(r[0]!.id).toBe(1);
    expect(r[1]!.id).toBe(2);
    expect(r[0]!.content).toBe("step one");
  });

  it("preserves createdAt for items kept across replace()", async () => {
    const s = new InMemoryTodoStore();
    s.replace([{ content: "first", status: "pending" }]);
    const initial = s.list()[0]!;
    await new Promise((r) => setTimeout(r, 5));
    const after = s.replace([
      { id: initial.id, content: "first", status: "in_progress" },
      { content: "second", status: "pending" },
    ]);
    expect(after[0]!.id).toBe(initial.id);
    expect(after[0]!.createdAt).toBe(initial.createdAt);
    expect(after[0]!.updatedAt).toBeGreaterThan(initial.updatedAt);
  });

  it("does not bump updatedAt when content+status are unchanged", async () => {
    const s = new InMemoryTodoStore();
    s.replace([{ content: "x", status: "pending" }]);
    const initial = s.list()[0]!;
    await new Promise((r) => setTimeout(r, 5));
    const again = s.replace([{ id: initial.id, content: "x", status: "pending" }]);
    expect(again[0]!.updatedAt).toBe(initial.updatedAt);
  });

  it("drops items that aren't in the new list (replace, not merge)", () => {
    const s = new InMemoryTodoStore();
    s.replace([
      { content: "a", status: "pending" },
      { content: "b", status: "pending" },
    ]);
    s.replace([{ id: 1, content: "a", status: "completed" }]);
    expect(s.list().map((i) => i.id)).toEqual([1]);
  });

  it("ignores unknown ids and assigns fresh ones", () => {
    const s = new InMemoryTodoStore();
    const r = s.replace([{ id: 999, content: "ghost", status: "pending" }]);
    // 999 didn't exist, so it gets a fresh id starting at 1.
    expect(r[0]!.id).toBe(1);
  });

  it("clear() empties the plan", () => {
    const s = new InMemoryTodoStore();
    s.replace([{ content: "x", status: "pending" }]);
    s.clear();
    expect(s.list()).toEqual([]);
  });

  it("list() returns copies (mutating doesn't affect the store)", () => {
    const s = new InMemoryTodoStore();
    s.replace([{ content: "x", status: "pending" }]);
    const copy = s.list();
    copy[0]!.content = "mutated";
    expect(s.list()[0]!.content).toBe("x");
  });
});

describe("formatTodos", () => {
  it("renders an empty plan with a hint", () => {
    expect(formatTodos([])).toMatch(/no plan yet/);
  });

  it("renders status markers for each item", () => {
    const out = formatTodos([
      { id: 1, content: "a", status: "completed", createdAt: 0, updatedAt: 0 },
      { id: 2, content: "b", status: "in_progress", createdAt: 0, updatedAt: 0 },
      { id: 3, content: "c", status: "pending", createdAt: 0, updatedAt: 0 },
    ]);
    expect(out).toContain("[x] #1 a");
    expect(out).toContain("[~] #2 b");
    expect(out).toContain("[ ] #3 c");
  });
});
