// Long-term memory contract. Storage is intentionally untyped beyond
// strings/tags so implementations (sqlite, postgres, files, vector) are free
// to choose retrieval strategy.

export interface MemoryRecord {
  id: number;
  kind: string;
  content: string;
  tags: string[];
  createdAt: number;
}

export interface MemoryStore {
  add(kind: string, content: string, tags?: string[]): number;
  search(query: string, limit?: number): MemoryRecord[];
  listRecent(limit: number): MemoryRecord[];
  close?(): void;
}
