import type { MemoryRecord, MemoryStore } from "@miniclaw/core";
import type { Embedder } from "./embedder.ts";
import { cosineSimilarity } from "./embedder.ts";

interface VectorRow {
  rec: MemoryRecord;
  vec: Float32Array;
}

export interface VectorMemoryStoreOpts {
  embedder: Embedder;
  /** Optional minimum cosine score for inclusion. Defaults to 0 (no floor). */
  minScore?: number;
}

/**
 * Semantic-search MemoryStore. Uses cosine similarity over embeddings to
 * rank `search()` hits — the same surface as memory-sqlite / memory-inmemory
 * so it can be swapped in transparently. The vector index is kept in memory;
 * tests construct a fresh one per case.
 *
 * Add/search are async because real embedders make network calls. The
 * MemoryStore interface signature is sync; we satisfy it by exposing the
 * sync variants too, backed by a queue of pending embeddings that callers
 * flush via `await waitForIngest()`. This is the deliberate trade-off:
 * a sync `add()` makes integration with the existing agent painless, but
 * tests that need deterministic results call `await waitForIngest()` first.
 */
export class VectorMemoryStore implements MemoryStore {
  private readonly embedder: Embedder;
  private readonly minScore: number;
  private readonly rows: VectorRow[] = [];
  private nextId = 1;
  // Track in-flight embed() promises so tests / callers can wait for them.
  // Each promise is wrapped to never reject — failures are captured in
  // `ingestError` so we don't trigger unhandled-rejection noise.
  private readonly inflight: Set<Promise<unknown>> = new Set();
  private ingestError: Error | null = null;

  constructor(opts: VectorMemoryStoreOpts) {
    this.embedder = opts.embedder;
    this.minScore = opts.minScore ?? 0;
  }

  add(kind: string, content: string, tags: string[] = []): number {
    const id = this.nextId++;
    const rec: MemoryRecord = {
      id,
      kind,
      content,
      tags: [...tags],
      createdAt: Date.now(),
    };
    // Reserve the slot synchronously so id-numbered ordering matches insert
    // order; fill in the vector when the embedder resolves.
    const row: VectorRow = { rec, vec: new Float32Array(this.embedder.dim) };
    this.rows.push(row);
    const p = this.embedder
      .embed(content)
      .then((v) => {
        if (v.length !== this.embedder.dim) {
          throw new Error(
            `embedder returned ${v.length}-dim vector, expected ${this.embedder.dim}`,
          );
        }
        row.vec = v;
      })
      .catch((err: Error) => {
        // Capture the first error and stop the row from polluting search.
        if (!this.ingestError) this.ingestError = err;
        // Drop the row so a failed embed isn't returned by listRecent /
        // semanticSearch with a zeroed vector.
        const idx = this.rows.indexOf(row);
        if (idx >= 0) this.rows.splice(idx, 1);
      });
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p));
    return id;
  }

  search(query: string, limit = 5): MemoryRecord[] {
    // Sync API — semantic search needs the query embedding, which is async.
    // Best we can do here: a token-overlap pre-filter as a graceful fallback.
    // Callers wanting true semantic search should use semanticSearch(...).
    return this.lexicalSearch(query, limit);
  }

  /** True semantic search. Embed the query, score by cosine, return top-k. */
  async semanticSearch(query: string, limit = 5): Promise<MemoryRecord[]> {
    if (this.rows.length === 0) return [];
    const qVec = await this.embedder.embed(query);
    if (qVec.length !== this.embedder.dim) {
      throw new Error(
        `embedder returned ${qVec.length}-dim query vec, expected ${this.embedder.dim}`,
      );
    }
    const scored = this.rows.map((r) => ({ rec: r.rec, score: cosineSimilarity(qVec, r.vec) }));
    scored.sort((a, b) => b.score - a.score || b.rec.id - a.rec.id);
    return scored
      .filter((s) => s.score >= this.minScore)
      .slice(0, limit)
      .map((s) => s.rec);
  }

  listRecent(limit: number): MemoryRecord[] {
    return [...this.rows].reverse().slice(0, limit).map((r) => r.rec);
  }

  /**
   * Wait for every queued embed() call to settle. Throws once if any
   * embed failed — surfacing dim-mismatch and provider errors instead of
   * silently corrupting the index. Clears the error after throwing so
   * subsequent flushes start clean.
   */
  async waitForIngest(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight]);
    }
    if (this.ingestError) {
      const err = this.ingestError;
      this.ingestError = null;
      throw err;
    }
  }

  close(): void {
    // No external resources; in-flight embeds drain on their own.
  }

  // ---- Internals ----

  private lexicalSearch(query: string, limit: number): MemoryRecord[] {
    const tokens = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    if (tokens.length === 0) return this.listRecent(limit);
    const scored: Array<{ rec: MemoryRecord; score: number }> = [];
    for (const { rec } of this.rows) {
      const hay = (rec.content + " " + rec.tags.join(" ")).toLowerCase();
      const matches = tokens.filter((t) => hay.includes(t)).length;
      if (matches > 0) scored.push({ rec, score: matches });
    }
    scored.sort((a, b) => b.score - a.score || b.rec.id - a.rec.id);
    return scored.slice(0, limit).map((s) => s.rec);
  }
}
