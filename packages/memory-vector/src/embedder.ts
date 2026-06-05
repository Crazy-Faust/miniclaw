/**
 * Pluggable embedding contract. Tests use a deterministic stub. Production
 * code can wrap any provider's embeddings API (OpenAI text-embedding-3,
 * Voyage, Cohere, local sentence-transformers via Ollama, ...).
 */
export interface Embedder {
  /** Stable, model-identifying name. Stored alongside the vector so a
   * MemoryStore can detect "this index was built with a different model".  */
  name: string;
  /** Embedding dimensionality. */
  dim: number;
  /** Produce a fixed-size vector for the given text. */
  embed(text: string): Promise<Float32Array>;
}

/**
 * Cheap, dependency-free fallback that hashes character n-grams into a
 * fixed-dimensional vector. Not semantically meaningful, but deterministic
 * and useful as a default when no real embedder is configured (e.g. in
 * tests or a smoke run of the package).
 */
export class HashingEmbedder implements Embedder {
  readonly name = "hashing-trigram";
  constructor(public readonly dim: number = 256) {}

  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dim);
    const norm = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
    if (norm.length === 0) return v;
    const padded = `  ${norm}  `;
    for (let i = 0; i < padded.length - 2; i++) {
      const tri = padded.slice(i, i + 3);
      const h = fnv1a(tri);
      const idx = h % this.dim;
      v[idx] = (v[idx] ?? 0) + 1;
    }
    return l2normalize(v);
  }
}

export function l2normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.sqrt(s);
  if (n === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
