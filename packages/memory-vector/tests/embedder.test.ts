import { describe, expect, it } from "vitest";
import { cosineSimilarity, HashingEmbedder, l2normalize } from "../src/index.ts";

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 6);
  });

  it("returns -1 for opposed vectors", () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0]))).toBeCloseTo(-1, 6);
  });

  it("returns 0 when one side is the zero vector (no NaN)", () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });

  it("throws on length mismatch", () => {
    expect(() => cosineSimilarity(new Float32Array(2), new Float32Array(3))).toThrow(/length mismatch/);
  });
});

describe("l2normalize", () => {
  it("scales vectors to unit length", () => {
    const out = l2normalize(new Float32Array([3, 4]));
    expect(Math.hypot(out[0]!, out[1]!)).toBeCloseTo(1, 6);
  });

  it("leaves the zero vector alone", () => {
    const out = l2normalize(new Float32Array([0, 0]));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
  });
});

describe("HashingEmbedder", () => {
  it("produces vectors of the configured dimension", async () => {
    const e = new HashingEmbedder(128);
    const v = await e.embed("hello world");
    expect(v.length).toBe(128);
  });

  it("returns a deterministic vector for the same input", async () => {
    const e = new HashingEmbedder();
    const a = await e.embed("the quick brown fox");
    const b = await e.embed("the quick brown fox");
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("similar strings score higher than unrelated ones", async () => {
    const e = new HashingEmbedder(512);
    const target = await e.embed("user prefers the helix editor");
    const close = await e.embed("user uses helix editor for coding");
    const far = await e.embed("the migration runs nightly at 3am UTC");
    expect(cosineSimilarity(target, close)).toBeGreaterThan(cosineSimilarity(target, far));
  });

  it("produces zero vector for empty / whitespace input (no division by zero)", async () => {
    const e = new HashingEmbedder();
    const v = await e.embed("   ");
    for (let i = 0; i < v.length; i++) expect(v[i]).toBe(0);
  });
});
