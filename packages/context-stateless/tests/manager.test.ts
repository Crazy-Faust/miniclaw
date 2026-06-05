import { describe, expect, it } from "vitest";
import { StatelessContextManager } from "../src/index.ts";

describe("StatelessContextManager", () => {
  it("returns the default system prompt plus the user message", () => {
    const ctx = new StatelessContextManager();
    const { system, messages } = ctx.prepare("hello");
    expect(system).toMatch(/Stateless mode/);
    expect(messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("honors a custom system prompt", () => {
    const ctx = new StatelessContextManager({ system: "you are a calculator" });
    const { system } = ctx.prepare("2+2");
    expect(system).toBe("you are a calculator");
  });

  it("records turns as no-ops (subsequent prepare() yields no history)", () => {
    const ctx = new StatelessContextManager();
    ctx.recordUser();
    ctx.recordAssistant();
    ctx.recordUser();
    const { messages } = ctx.prepare("next");
    expect(messages).toEqual([{ role: "user", content: "next" }]);
  });

  it("two prepare() calls in a row are independent", () => {
    const ctx = new StatelessContextManager();
    const a = ctx.prepare("first");
    const b = ctx.prepare("second");
    expect(a.messages).toEqual([{ role: "user", content: "first" }]);
    expect(b.messages).toEqual([{ role: "user", content: "second" }]);
  });
});
