import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fail, ok, type Skill, toolSpecFromSkill } from "../src/index.ts";

describe("ok / fail", () => {
  it("ok wraps output with ok=true", () => {
    expect(ok("hello")).toEqual({ ok: true, output: "hello" });
  });
  it("fail wraps output with ok=false", () => {
    expect(fail("nope")).toEqual({ ok: false, output: "nope" });
  });
});

describe("toolSpecFromSkill", () => {
  const skill: Skill<{ q: string; n: number }> = {
    name: "echo",
    description: "echoes back",
    parameters: z.object({
      q: z.string().describe("the query"),
      n: z.number().int().default(3),
    }),
    execute: () => ok("ignored"),
  };

  it("copies name and description", () => {
    const spec = toolSpecFromSkill(skill);
    expect(spec.name).toBe("echo");
    expect(spec.description).toBe("echoes back");
  });

  it("emits a JSON-Schema-ish object as inputSchema", () => {
    const spec = toolSpecFromSkill(skill);
    expect(spec.inputSchema).toMatchObject({ type: "object" });
    const props = (spec.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty("q");
    expect(props).toHaveProperty("n");
  });

  it("strips $schema (Anthropic ignores it but it's noise)", () => {
    const spec = toolSpecFromSkill(skill);
    expect(spec.inputSchema).not.toHaveProperty("$schema");
  });

  it("preserves required vs optional from zod defaults", () => {
    const spec = toolSpecFromSkill(skill);
    const required = (spec.inputSchema as { required?: string[] }).required ?? [];
    expect(required).toContain("q");
    // `n` has a default so it's optional in the input schema
    expect(required).not.toContain("n");
  });
});
