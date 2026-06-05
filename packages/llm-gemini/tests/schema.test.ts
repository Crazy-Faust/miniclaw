import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { sanitizeForGemini } from "../src/schema.ts";

function jsonSchemaOf(s: z.ZodType): unknown {
  const out = zodToJsonSchema(s, { target: "jsonSchema7" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

function deepKeys(obj: unknown): string[] {
  const out: string[] = [];
  function walk(v: unknown): void {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v === null || typeof v !== "object") return;
    for (const [k, child] of Object.entries(v)) {
      out.push(k);
      walk(child);
    }
  }
  walk(obj);
  return out;
}

describe("sanitizeForGemini", () => {
  it("strips additionalProperties from a zod object schema", () => {
    const raw = jsonSchemaOf(z.object({ name: z.string() }));
    const keysBefore = deepKeys(raw);
    expect(keysBefore).toContain("additionalProperties");

    const clean = sanitizeForGemini(raw);
    expect(deepKeys(clean)).not.toContain("additionalProperties");
  });

  it("strips exclusiveMinimum from .positive() / .min() on numbers", () => {
    // Mirrors what skills-cron does for `id: z.number().int().positive()`.
    const raw = jsonSchemaOf(z.object({ id: z.number().int().positive() }));
    expect(deepKeys(raw)).toContain("exclusiveMinimum");

    const clean = sanitizeForGemini(raw);
    expect(deepKeys(clean)).not.toContain("exclusiveMinimum");
  });

  it("strips $schema, $ref, definitions, oneOf, allOf, const", () => {
    const raw = {
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
      $ref: "#/definitions/foo",
      definitions: { foo: { type: "string" } },
      oneOf: [{ type: "string" }, { type: "number" }],
      allOf: [{ type: "string" }],
      const: 42,
      properties: { x: { type: "string" } },
    };
    const clean = sanitizeForGemini(raw) as Record<string, unknown>;
    expect(clean).not.toHaveProperty("$schema");
    expect(clean).not.toHaveProperty("$ref");
    expect(clean).not.toHaveProperty("definitions");
    expect(clean).not.toHaveProperty("oneOf");
    expect(clean).not.toHaveProperty("allOf");
    expect(clean).not.toHaveProperty("const");
  });

  it("converts a string const into a single-element enum", () => {
    const clean = sanitizeForGemini({ const: "exact" }) as Record<string, unknown>;
    expect(clean.enum).toEqual(["exact"]);
    expect(clean.type).toBe("string");
  });

  it("recursively cleans nested properties", () => {
    const raw = jsonSchemaOf(
      z.object({
        nested: z.object({
          id: z.number().int().positive(),
          tags: z.array(z.string()),
        }),
      }),
    );
    expect(deepKeys(raw)).toContain("additionalProperties");
    expect(deepKeys(raw)).toContain("exclusiveMinimum");

    const clean = sanitizeForGemini(raw);
    const cleanKeys = deepKeys(clean);
    expect(cleanKeys).not.toContain("additionalProperties");
    expect(cleanKeys).not.toContain("exclusiveMinimum");
  });

  it("preserves allowed fields verbatim", () => {
    const raw = {
      type: "object",
      description: "a thing",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 100, description: "the name" },
        count: { type: "integer", minimum: 0, maximum: 50 },
        kind: { type: "string", enum: ["a", "b", "c"] },
      },
      required: ["name"],
    };
    expect(sanitizeForGemini(raw)).toEqual(raw);
  });

  it("does not mutate the input", () => {
    const raw = jsonSchemaOf(z.object({ id: z.number().int().positive() }));
    const before = JSON.stringify(raw);
    sanitizeForGemini(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });
});
