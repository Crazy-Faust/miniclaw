import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ok, type Skill, SkillRegistry } from "../src/index.ts";

function makeSkill(name: string): Skill<{ x: number }> {
  return {
    name,
    description: `dummy skill ${name}`,
    parameters: z.object({ x: z.number() }),
    execute: ({ x }) => ok(`got ${x}`),
  };
}

describe("SkillRegistry", () => {
  it("registers and retrieves skills", () => {
    const r = new SkillRegistry();
    r.register(makeSkill("a"));
    r.register(makeSkill("b"));
    expect(r.list().map((s) => s.name)).toEqual(["a", "b"]);
    expect(r.get("b").description).toContain("dummy skill b");
  });

  it("throws on duplicate name", () => {
    const r = new SkillRegistry();
    r.register(makeSkill("a"));
    expect(() => r.register(makeSkill("a"))).toThrow(/already registered/);
  });

  it("produces valid tool specs with input schemas", () => {
    const r = new SkillRegistry();
    r.register(makeSkill("a"));
    const specs = r.toolSpecs();
    expect(specs).toHaveLength(1);
    expect(specs[0]!.name).toBe("a");
    expect(specs[0]!.inputSchema).toMatchObject({ type: "object" });
    expect(
      (specs[0]!.inputSchema as { properties: Record<string, unknown> }).properties,
    ).toHaveProperty("x");
  });

  it("throws on unknown skill lookup", () => {
    const r = new SkillRegistry();
    expect(() => r.get("nope")).toThrow(/unknown skill/);
  });
});
