import { describe, expect, it } from "vitest";
import { HashingEmbedder, type Embedder, VectorMemoryStore } from "../src/index.ts";

describe("VectorMemoryStore — MemoryStore contract", () => {
  it("add() returns a monotonically increasing id", () => {
    const s = new VectorMemoryStore({ embedder: new HashingEmbedder() });
    const a = s.add("fact", "x");
    const b = s.add("fact", "y");
    expect(b).toBeGreaterThan(a);
  });

  it("listRecent() returns inserted records, newest first", async () => {
    const s = new VectorMemoryStore({ embedder: new HashingEmbedder() });
    s.add("fact", "alpha");
    s.add("fact", "beta");
    s.add("fact", "gamma");
    await s.waitForIngest();
    expect(s.listRecent(2).map((r) => r.content)).toEqual(["gamma", "beta"]);
  });

  it("semanticSearch ranks similar content above unrelated content", async () => {
    const s = new VectorMemoryStore({ embedder: new HashingEmbedder(512) });
    s.add("preference", "user prefers the helix editor for coding");
    s.add("fact", "the deploy pipeline runs nightly via cron");
    s.add("fact", "user enjoys editing in helix every day");
    await s.waitForIngest();

    const hits = await s.semanticSearch("which editor does the user like?", 3);
    // The deploy fact must rank below at least one helix entry.
    const helixRanks = hits
      .map((h, i) => ({ helix: h.content.includes("helix"), i }))
      .filter((x) => x.helix)
      .map((x) => x.i);
    const deployRank = hits.findIndex((h) => h.content.includes("nightly"));
    expect(helixRanks.length).toBeGreaterThan(0);
    expect(Math.min(...helixRanks)).toBeLessThan(deployRank);
  });

  it("semanticSearch respects the limit parameter", async () => {
    const s = new VectorMemoryStore({ embedder: new HashingEmbedder() });
    for (let i = 0; i < 5; i++) s.add("fact", `item ${i}`);
    await s.waitForIngest();
    const hits = await s.semanticSearch("item", 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it("semanticSearch returns [] for an empty store", async () => {
    const s = new VectorMemoryStore({ embedder: new HashingEmbedder() });
    expect(await s.semanticSearch("anything", 5)).toEqual([]);
  });

  it("minScore filters out low-similarity hits", async () => {
    // High floor — only near-exact matches survive.
    const s = new VectorMemoryStore({ embedder: new HashingEmbedder(512), minScore: 0.95 });
    s.add("fact", "user prefers the helix editor");
    s.add("fact", "the build server is rebooting");
    await s.waitForIngest();
    const hits = await s.semanticSearch("user prefers the helix editor", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toMatch(/helix/);
  });

  it("sync search() falls back to lexical token overlap so the agent isn't broken", async () => {
    const s = new VectorMemoryStore({ embedder: new HashingEmbedder() });
    s.add("fact", "user prefers helix editor");
    s.add("fact", "unrelated fact");
    await s.waitForIngest();
    const hits = s.search("helix");
    expect(hits.map((h) => h.content)[0]).toMatch(/helix/);
  });

  it("rejects embedder vectors with mismatched dimensionality", async () => {
    class BadEmbedder implements Embedder {
      readonly name = "bad";
      readonly dim = 8;
      async embed() {
        // Returns wrong size.
        return new Float32Array(7);
      }
    }
    const s = new VectorMemoryStore({ embedder: new BadEmbedder() });
    s.add("fact", "x");
    await expect(s.waitForIngest()).rejects.toThrow(/expected 8/);
  });

  it("waitForIngest resolves when all embed() calls settle", async () => {
    let inflight = 0;
    class SlowEmbedder implements Embedder {
      readonly name = "slow";
      readonly dim = 4;
      async embed() {
        inflight++;
        await new Promise((r) => setTimeout(r, 5));
        inflight--;
        return new Float32Array([1, 0, 0, 0]);
      }
    }
    const s = new VectorMemoryStore({ embedder: new SlowEmbedder() });
    for (let i = 0; i < 5; i++) s.add("fact", `n${i}`);
    expect(inflight).toBeGreaterThan(0);
    await s.waitForIngest();
    expect(inflight).toBe(0);
  });
});
