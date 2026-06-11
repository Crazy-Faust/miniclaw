// Long-term memory contracts. MemoryStore is the raw/source-compatible layer
// used by simple backends. KnowledgeStore is the compiled retrieval layer used
// by wiki-aware backends.

export interface MemoryRecord {
  id: number;
  kind: string;
  content: string;
  tags: string[];
  createdAt: number;
  folder?: string;
  status?: MemoryStatus;
  canonicalPagePath?: string | null;
}

export type MemoryStatus = "active" | "duplicate" | "superseded" | "retired";

export interface MemoryAddOptions {
  folder?: string;
}

export interface MemorySearchOptions {
  folder?: string;
}

export interface KnowledgeSearchOptions extends MemorySearchOptions {
  /**
   * Wiki-aware stores should prefer compiled wiki pages. Raw memory/source rows
   * are useful as a fallback while maintenance has not integrated them yet.
   */
  includeRawSources?: boolean;
}

export interface MemoryStore {
  add(kind: string, content: string, tags?: string[], opts?: MemoryAddOptions): number;
  search(query: string, limit?: number, opts?: MemorySearchOptions): MemoryRecord[];
  listRecent(limit: number): MemoryRecord[];
  close?(): void;
}

export interface WikiFolderRecord {
  path: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface WikiPageRecord {
  path: string;
  folder: string;
  title: string;
  content: string;
  tags: string[];
  sourceMemoryIds: number[];
  createdAt: number;
  updatedAt: number;
}

export interface WikiPageInput {
  path: string;
  folder?: string;
  title: string;
  content: string;
  tags?: string[];
  sourceMemoryIds?: number[];
}

export interface WikiSearchResult {
  path: string;
  folder: string;
  title: string;
  content: string;
  tags: string[];
  sourceMemoryIds: number[];
}

export type WikiMaintenanceAction =
  | {
      type: "upsert_page";
      path: string;
      folder?: string;
      title: string;
      content: string;
      tags?: string[];
      sourceMemoryIds?: number[];
    }
  | {
      type: "add_link";
      fromPath: string;
      toPath: string;
      kind?: string;
    }
  | {
      type: "mark_memory";
      memoryId: number;
      status: MemoryStatus;
      canonicalPagePath?: string | null;
      folder?: string;
    }
  | {
      type: "append_log";
      eventType?: string;
      message: string;
      metadata?: Record<string, unknown>;
    };

export interface KnowledgeSearchResult {
  source: "memory" | "wiki";
  id?: number;
  path?: string;
  folder: string;
  title: string;
  content: string;
  tags: string[];
}

export interface WikiStore {
  upsertWikiPage(page: WikiPageInput): void;
  readWikiPage(path: string): WikiPageRecord | null;
  listWikiPages(folder?: string, limit?: number): WikiPageRecord[];
  listWikiFolders(): WikiFolderRecord[];
  searchWiki(query: string, limit?: number): WikiSearchResult[];
  addWikiLink(fromPath: string, toPath: string, kind?: string): void;
  appendWikiLog(eventType: string, message: string, metadata?: Record<string, unknown>): number;
  applyWikiMaintenanceActions(actions: WikiMaintenanceAction[]): void;
  updateMemoryMetadata(
    memoryId: number,
    patch: { folder?: string; status?: MemoryStatus; canonicalPagePath?: string | null },
  ): void;
}

export interface KnowledgeStore {
  searchKnowledge(query: string, limit?: number, opts?: KnowledgeSearchOptions): KnowledgeSearchResult[];
}

export type MemoryMaintenanceJobStatus = "pending" | "running" | "completed" | "failed";

export interface MemoryMaintenanceJob {
  id: number;
  type: string;
  memoryId: number | null;
  payload: Record<string, unknown>;
  status: MemoryMaintenanceJobStatus;
  attempts: number;
  availableAt: number;
  claimedAt: number | null;
  workerId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryMaintenanceQueue {
  enqueueMemoryMaintenanceJob(
    type: string,
    memoryId: number | null,
    payload: Record<string, unknown>,
  ): number;
  claimMemoryMaintenanceJobs(limit: number, workerId: string, now?: number): MemoryMaintenanceJob[];
  completeMemoryMaintenanceJob(id: number, resultSummary: string): void;
  failMemoryMaintenanceJob(id: number, error: string, retryDelayMs?: number): void;
  pendingMemoryMaintenanceJobs(limit?: number): MemoryMaintenanceJob[];
}

export const DEFAULT_MEMORY_FOLDER = "inbox";

export function normalizeMemoryFolderPath(folder: string | undefined): string {
  const raw = (folder ?? DEFAULT_MEMORY_FOLDER).trim();
  if (!raw) return DEFAULT_MEMORY_FOLDER;
  return normalizeRelativePath(raw);
}

export function normalizeWikiPagePath(path: string, folder?: string): string {
  const base = path.includes("/") || !folder
    ? path
    : `${normalizeMemoryFolderPath(folder)}/${path}`;
  const normalized = normalizeRelativePath(base);
  return /\.[A-Za-z0-9]+$/.test(normalized) ? normalized : `${normalized}.md`;
}

function normalizeRelativePath(path: string): string {
  const raw = path.trim().replace(/\\/g, "/");
  if (!raw) throw new Error("path must not be empty");
  if (raw.startsWith("/")) throw new Error("path must be relative");
  const parts = raw.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error("path must not be empty");
  for (const part of parts) {
    if (part === "." || part === "..") throw new Error("path must not contain . or .. segments");
    if (/[\u0000-\u001F]/u.test(part)) throw new Error("path must not contain control characters");
  }
  return parts.join("/");
}
