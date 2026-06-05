import { describe, expect, it } from "vitest";
import { paramToZod, parseParamSpec } from "../src/make-skill/index.ts";

describe("parseParamSpec", () => {
  it("returns [] for blank input", () => {
    expect(parseParamSpec("")).toEqual([]);
    expect(parseParamSpec("   ")).toEqual([]);
  });

  it("parses a single required string", () => {
    expect(parseParamSpec("url:string")).toEqual([
      { name: "url", type: "string", optional: false },
    ]);
  });

  it("parses multiple params with optional + array types", () => {
    expect(parseParamSpec("url:string, timeout:number?, headers:string[]?"))
      .toEqual([
        { name: "url", type: "string", optional: false },
        { name: "timeout", type: "number", optional: true },
        { name: "headers", type: "string[]", optional: true },
      ]);
  });

  it("rejects duplicate names", () => {
    expect(() => parseParamSpec("a:string, a:number")).toThrow(/duplicate/);
  });

  it("rejects invalid type", () => {
    expect(() => parseParamSpec("a:bigint")).toThrow(/unknown type/);
  });

  it("rejects invalid name", () => {
    expect(() => parseParamSpec("1foo:string")).toThrow(/invalid parameter name/);
  });

  it("rejects missing colon", () => {
    expect(() => parseParamSpec("url-string")).toThrow(/expected 'name:type'/);
  });
});

describe("paramToZod", () => {
  it("emits z.string() for required string", () => {
    expect(paramToZod({ name: "url", type: "string", optional: false }))
      .toMatch(/^z\.string\(\)\.describe/);
  });

  it("emits .optional() for optional params", () => {
    expect(paramToZod({ name: "n", type: "number", optional: true }))
      .toMatch(/^z\.number\(\)\.optional\(\)\.describe/);
  });

  it("emits z.array(z.string()) for string[]", () => {
    expect(paramToZod({ name: "h", type: "string[]", optional: false }))
      .toMatch(/^z\.array\(z\.string\(\)\)\.describe/);
  });
});
