import Database from "better-sqlite3";
import { chmodSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import {
  normalizeMemoryFolderPath,
  normalizeWikiPagePath,
} from "@miniclaw/core";
import type {
  AuditSink,
  ChannelAllowlist,
  ConversationStore,
  ConversationSummary,
  CronJobRecord,
  CronStore,
  KnowledgeSearchResult,
  KnowledgeSearchOptions,
  KnowledgeStore,
  LLMUsageRecord,
  LLMUsageSink,
  MemoryAddOptions,
  MemoryMaintenanceJob,
  MemoryMaintenanceQueue,
  MemoryRecord,
  MemorySearchOptions,
  MemoryStatus,
  MemoryStore,
  MessageRecord,
  PairingRecord,
  PairingStore,
  SessionRecord,
  SessionStore,
  WikiFolderRecord,
  WikiMaintenanceAction,
  WikiPageInput,
  WikiPageRecord,
  WikiSearchResult,
  WikiStore,
} from "@miniclaw/core";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, "schema.sql"), "utf8");
const LLM_USAGE_PAGE_PATH = "system/llm-usage.md";
const PROTECTED_WIKI_PAGE_PATHS = new Set([LLM_USAGE_PAGE_PATH]);

// Single SQLite file implements three contracts. A future split (e.g.
// audit-postgres) only needs to keep its slice of these methods.
export class SqliteStore
  implements
    MemoryStore,
    WikiStore,
    KnowledgeStore,
    LLMUsageSink,
    MemoryMaintenanceQueue,
    ConversationStore,
    AuditSink,
    SessionStore,
    CronStore,
    ChannelAllowlist,
    PairingStore
{
  private readonly db: Database.Database;
  readonly path: string;

  constructor(dbPath: string) {
    this.path = dbPath;
    try {
      this.db = new Database(dbPath);
    } catch (err) {
      throw new Error(sqliteNativeDependencyMessage(err));
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
    this.ensureSystemWikiPages();

    // VULN-15: Restrict database file permissions to owner-only (0600).
    // The DB may contain conversation history, memories, API keys the user
    // asked to remember, and pairing codes. Skip for in-memory DBs.
    if (dbPath !== ":memory:" && !dbPath.startsWith(":")) {
      try { chmodSync(dbPath, 0o600); } catch { /* best-effort — tests use tmpdir */ }
      // WAL mode creates -wal and -shm sidecar files; restrict them too.
      try { chmodSync(dbPath + "-wal", 0o600); } catch { /* may not exist yet */ }
      try { chmodSync(dbPath + "-shm", 0o600); } catch { /* may not exist yet */ }
    }
  }

  private migrate(): void {
    const cronCols = this.db.pragma("table_info(cron_jobs)") as Array<{ name: string }>;
    if (!cronCols.some((c) => c.name === "channel")) {
      this.db.exec("ALTER TABLE cron_jobs ADD COLUMN channel TEXT");
    }
    const usageCols = this.db.pragma("table_info(llm_usage_events)") as Array<{ name: string }>;
    const addUsageCol = (name: string, ddl: string): void => {
      if (!usageCols.some((c) => c.name === name)) this.db.exec(ddl);
    };
    addUsageCol("task_kind", "ALTER TABLE llm_usage_events ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'unknown'");
    addUsageCol("task_name", "ALTER TABLE llm_usage_events ADD COLUMN task_name TEXT");
    addUsageCol("channel", "ALTER TABLE llm_usage_events ADD COLUMN channel TEXT");
    addUsageCol("session_id", "ALTER TABLE llm_usage_events ADD COLUMN session_id TEXT");
    addUsageCol("conversation_id", "ALTER TABLE llm_usage_events ADD COLUMN conversation_id INTEGER");
    addUsageCol("component", "ALTER TABLE llm_usage_events ADD COLUMN component TEXT");
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS llm_usage_events_task_idx
       ON llm_usage_events(task_kind, role, ts)`,
    );
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_metadata(memory_id, folder_path, status, updated_at)
         SELECT id, 'inbox', 'active', created_at FROM memories`,
      )
      .run();
  }

  private ensureSystemWikiPages(): void {
    this.refreshLLMUsageWikiPage();
  }

  // ---- MemoryStore ----

  add(kind: string, content: string, tags: string[] = [], opts: MemoryAddOptions = {}): number {
    const folder = normalizeMemoryFolderPath(opts.folder);
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare("INSERT INTO memories(kind, content, tags, created_at) VALUES (?, ?, ?, ?)")
        .run(kind, content, tags.join(" "), now);
      const id = Number(info.lastInsertRowid);
      this.db
        .prepare(
          `INSERT INTO memory_metadata(memory_id, folder_path, status, updated_at)
           VALUES (?, ?, 'active', ?)
           ON CONFLICT(memory_id) DO UPDATE SET
             folder_path = excluded.folder_path,
             status = 'active',
             updated_at = excluded.updated_at`,
        )
        .run(id, folder, now);
      this.enqueueMemoryMaintenanceJob("memory_write", id, {
        memoryId: id,
        kind,
        content,
        tags,
        folder,
        createdAt: now,
      });
      return id;
    });
    return tx();
  }

  search(query: string, limit = 5, opts: MemorySearchOptions = {}): MemoryRecord[] {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return this.listRecent(limit);
    const folder = opts.folder ? normalizeMemoryFolderPath(opts.folder) : null;
    const rows = this.db
      .prepare(
        `SELECT m.id, m.kind, m.content, m.tags, m.created_at AS createdAt,
                mm.folder_path AS folder, mm.status AS status,
                mm.canonical_page_path AS canonicalPagePath
         FROM memories_fts f
         JOIN memories m ON m.id = f.rowid
         JOIN memory_metadata mm ON mm.memory_id = m.id
         WHERE memories_fts MATCH ?
           AND mm.status = 'active'
           AND (? IS NULL OR mm.folder_path = ?)
         ORDER BY rank
         LIMIT ?`,
      )
      .all(sanitized, folder, folder, limit) as RawMemoryRow[];
    return rows.map(toMemoryRecord);
  }

  listRecent(limit: number): MemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.kind, m.content, m.tags, m.created_at AS createdAt,
                mm.folder_path AS folder, mm.status AS status,
                mm.canonical_page_path AS canonicalPagePath
         FROM memories m
         LEFT JOIN memory_metadata mm ON mm.memory_id = m.id
         ORDER BY m.id DESC LIMIT ?`,
      )
      .all(limit) as RawMemoryRow[];
    return rows.map(toMemoryRecord);
  }

  // ---- WikiStore / KnowledgeStore ----

  upsertWikiPage(input: WikiPageInput): void {
    this.upsertWikiPageInternal(input, { allowProtected: false });
  }

  private upsertWikiPageInternal(
    input: WikiPageInput,
    opts: { allowProtected: boolean },
  ): void {
    const path = normalizeWikiPagePath(input.path, input.folder);
    if (!opts.allowProtected && isProtectedWikiPagePath(path)) {
      throw new Error(`wiki page is system-protected: ${path}`);
    }
    const folder = normalizeMemoryFolderPath(input.folder ?? folderFromWikiPath(path));
    const now = Date.now();
    const tags = (input.tags ?? []).join(" ");
    const sourceIds = JSON.stringify([...(input.sourceMemoryIds ?? [])].filter(Number.isFinite));
    const tx = this.db.transaction(() => {
      this.upsertWikiFolder(folder, titleFromPath(folder), now);
      const existing = this.db
        .prepare("SELECT created_at AS createdAt FROM wiki_pages WHERE path = ?")
        .get(path) as { createdAt: number } | undefined;
      this.db
        .prepare(
          `INSERT INTO wiki_pages(path, folder_path, title, content, tags, source_memory_ids, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             folder_path = excluded.folder_path,
             title = excluded.title,
             content = excluded.content,
             tags = excluded.tags,
             source_memory_ids = excluded.source_memory_ids,
             updated_at = excluded.updated_at`,
        )
        .run(path, folder, input.title, input.content, tags, sourceIds, existing?.createdAt ?? now, now);
      for (const id of input.sourceMemoryIds ?? []) {
        this.updateMemoryMetadata(id, { canonicalPagePath: path });
      }
    });
    tx();
  }

  readWikiPage(path: string): WikiPageRecord | null {
    const normalized = normalizeWikiPagePath(path);
    if (isProtectedWikiPagePath(normalized)) return null;
    return this.readWikiPageInternal(normalized);
  }

  readLLMUsageWikiPage(): WikiPageRecord {
    const existing = this.readWikiPageInternal(LLM_USAGE_PAGE_PATH);
    if (existing) return existing;
    this.refreshLLMUsageWikiPage();
    const created = this.readWikiPageInternal(LLM_USAGE_PAGE_PATH);
    if (!created) throw new Error("failed to create LLM usage wiki page");
    return created;
  }

  private readWikiPageInternal(path: string): WikiPageRecord | null {
    const row = this.db
      .prepare(
        `SELECT path, folder_path AS folder, title, content, tags,
                source_memory_ids AS sourceMemoryIds, created_at AS createdAt, updated_at AS updatedAt
         FROM wiki_pages WHERE path = ?`,
      )
      .get(path) as RawWikiPageRow | undefined;
    return row ? toWikiPageRecord(row) : null;
  }

  listWikiPages(folder?: string, limit = 50): WikiPageRecord[] {
    const normalizedFolder = folder ? normalizeMemoryFolderPath(folder) : null;
    const rows = this.db
      .prepare(
        `SELECT path, folder_path AS folder, title, content, tags,
                source_memory_ids AS sourceMemoryIds, created_at AS createdAt, updated_at AS updatedAt
         FROM wiki_pages
         WHERE (? IS NULL OR folder_path = ?)
           AND path != ?
         ORDER BY updated_at DESC, path ASC
         LIMIT ?`,
      )
      .all(normalizedFolder, normalizedFolder, LLM_USAGE_PAGE_PATH, limit) as RawWikiPageRow[];
    return rows.map(toWikiPageRecord);
  }

  listWikiFolders(): WikiFolderRecord[] {
    return this.db
      .prepare(
        `SELECT path, title, created_at AS createdAt, updated_at AS updatedAt
         FROM wiki_folders f
         WHERE EXISTS (
           SELECT 1 FROM wiki_pages p
           WHERE p.folder_path = f.path AND p.path != ?
         )
         ORDER BY path ASC`,
      )
      .all(LLM_USAGE_PAGE_PATH) as WikiFolderRecord[];
  }

  searchWiki(query: string, limit = 5): WikiSearchResult[] {
    const sanitized = sanitizeFtsQuery(query);
    const rows = sanitized
      ? this.db
          .prepare(
            `SELECT p.path, p.folder_path AS folder, p.title, p.content, p.tags,
                    p.source_memory_ids AS sourceMemoryIds
             FROM wiki_pages_fts f
             JOIN wiki_pages p ON p.rowid = f.rowid
             WHERE wiki_pages_fts MATCH ?
               AND p.path != ?
             ORDER BY rank
             LIMIT ?`,
          )
          .all(sanitized, LLM_USAGE_PAGE_PATH, limit) as RawWikiSearchRow[]
      : this.db
          .prepare(
            `SELECT path, folder_path AS folder, title, content, tags,
                    source_memory_ids AS sourceMemoryIds
             FROM wiki_pages
             WHERE path != ?
             ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(LLM_USAGE_PAGE_PATH, limit) as RawWikiSearchRow[];
    return rows.map(toWikiSearchResult);
  }

  addWikiLink(fromPath: string, toPath: string, kind = "related"): void {
    const from = normalizeWikiPagePath(fromPath);
    const to = normalizeWikiPagePath(toPath);
    if (isProtectedWikiPagePath(from) || isProtectedWikiPagePath(to)) {
      throw new Error("wiki link touches a system-protected page");
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO wiki_links(from_path, to_path, kind, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(from, to, kind.trim() || "related", Date.now());
  }

  appendWikiLog(eventType: string, message: string, metadata: Record<string, unknown> = {}): number {
    const info = this.db
      .prepare(
        `INSERT INTO wiki_log(ts, event_type, message, metadata_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(Date.now(), eventType, message, safeJson(metadata));
    return Number(info.lastInsertRowid);
  }

  applyWikiMaintenanceActions(actions: WikiMaintenanceAction[]): void {
    const tx = this.db.transaction(() => {
      for (const action of actions) {
        switch (action.type) {
          case "upsert_page": {
            const path = normalizeWikiPagePath(action.path, action.folder);
            if (isProtectedWikiPagePath(path)) {
              this.appendWikiLog("maintenance_skipped", `skipped protected page update: ${path}`, {
                path,
                reason: "system_protected",
              });
              break;
            }
            this.upsertWikiPage(action);
            break;
          }
          case "add_link": {
            const from = normalizeWikiPagePath(action.fromPath);
            const to = normalizeWikiPagePath(action.toPath);
            if (isProtectedWikiPagePath(from) || isProtectedWikiPagePath(to)) {
              this.appendWikiLog("maintenance_skipped", "skipped protected page link", {
                fromPath: from,
                toPath: to,
                reason: "system_protected",
              });
              break;
            }
            this.addWikiLink(action.fromPath, action.toPath, action.kind);
            break;
          }
          case "mark_memory": {
            const canonicalPagePath = action.canonicalPagePath &&
              isProtectedWikiPagePath(normalizeWikiPagePath(action.canonicalPagePath))
              ? undefined
              : action.canonicalPagePath;
            this.updateMemoryMetadata(action.memoryId, {
              folder: action.folder,
              status: action.status,
              canonicalPagePath,
            });
            break;
          }
          case "append_log":
            this.appendWikiLog(action.eventType ?? "maintenance", action.message, action.metadata);
            break;
        }
      }
    });
    tx();
  }

  updateMemoryMetadata(
    memoryId: number,
    patch: { folder?: string; status?: MemoryStatus; canonicalPagePath?: string | null },
  ): void {
    const current = this.db
      .prepare("SELECT memory_id AS memoryId FROM memory_metadata WHERE memory_id = ?")
      .get(memoryId) as { memoryId: number } | undefined;
    if (!current) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO memory_metadata(memory_id, folder_path, status, updated_at)
           VALUES (?, 'inbox', 'active', ?)`,
        )
        .run(memoryId, Date.now());
    }
    const folder = patch.folder === undefined ? undefined : normalizeMemoryFolderPath(patch.folder);
    const canonicalPagePath = patch.canonicalPagePath === undefined
      ? undefined
      : patch.canonicalPagePath === null
        ? null
        : normalizeWikiPagePath(patch.canonicalPagePath);
    const status = patch.status;
    if (status && !isMemoryStatus(status)) throw new Error(`invalid memory status: ${status}`);
    this.db
      .prepare(
        `UPDATE memory_metadata SET
           folder_path = COALESCE(?, folder_path),
           status = COALESCE(?, status),
           canonical_page_path = CASE WHEN ? THEN ? ELSE canonical_page_path END,
           updated_at = ?
         WHERE memory_id = ?`,
      )
      .run(
        folder ?? null,
        status ?? null,
        canonicalPagePath !== undefined ? 1 : 0,
        canonicalPagePath ?? null,
        Date.now(),
        memoryId,
      );
  }

  private upsertWikiFolder(path: string, title: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO wiki_folders(path, title, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           title = excluded.title,
           updated_at = excluded.updated_at`,
      )
      .run(path, title, now, now);
  }

  searchKnowledge(
    query: string,
    limit = 5,
    opts: KnowledgeSearchOptions = {},
  ): KnowledgeSearchResult[] {
    const folder = opts.folder ? normalizeMemoryFolderPath(opts.folder) : undefined;
    const wikiSearchLimit = folder ? Math.max(limit * 4, 20) : limit;
    const wikiHits = this.searchWiki(query, wikiSearchLimit)
      .filter((w) => !folder || w.folder === folder)
      .slice(0, limit)
      .map<KnowledgeSearchResult>((w) => ({
        source: "wiki",
        path: w.path,
        folder: w.folder,
        title: w.title,
        content: w.content,
        tags: w.tags,
      }));
    if (wikiHits.length > 0 || opts.includeRawSources === false) {
      return wikiHits;
    }

    return this.search(query, limit, { folder }).map<KnowledgeSearchResult>((m) => ({
      source: "memory",
      id: m.id,
      folder: m.folder ?? "inbox",
      title: `Raw source memory #${m.id}`,
      content: m.content,
      tags: m.tags,
    }));
  }

  // ---- MemoryMaintenanceQueue ----

  enqueueMemoryMaintenanceJob(
    type: string,
    memoryId: number | null,
    payload: Record<string, unknown>,
  ): number {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO memory_maintenance_jobs(
           type, memory_id, payload_json, status, attempts, available_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(type, memoryId, safeJson(payload), now, now, now);
    return Number(info.lastInsertRowid);
  }

  claimMemoryMaintenanceJobs(limit: number, workerId: string, now = Date.now()): MemoryMaintenanceJob[] {
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id FROM memory_maintenance_jobs
           WHERE status = 'pending' AND available_at <= ?
           ORDER BY id ASC LIMIT ?`,
        )
        .all(now, limit) as Array<{ id: number }>;
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      this.db
        .prepare(
          `UPDATE memory_maintenance_jobs SET
             status = 'running',
             attempts = attempts + 1,
             claimed_at = ?,
             worker_id = ?,
             updated_at = ?
           WHERE id IN (${placeholders})`,
        )
        .run(now, workerId, now, ...ids);
      return this.db
        .prepare(
          `SELECT id, type, memory_id AS memoryId, payload_json AS payloadJson,
                  status, attempts, available_at AS availableAt, claimed_at AS claimedAt,
                  worker_id AS workerId, last_error AS lastError,
                  created_at AS createdAt, updated_at AS updatedAt
           FROM memory_maintenance_jobs
           WHERE id IN (${placeholders})
           ORDER BY id ASC`,
        )
        .all(...ids) as RawMaintenanceJobRow[];
    });
    return tx().map(toMaintenanceJob);
  }

  completeMemoryMaintenanceJob(id: number, resultSummary: string): void {
    this.db
      .prepare(
        `UPDATE memory_maintenance_jobs SET
           status = 'completed',
           result_summary = ?,
           last_error = NULL,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(resultSummary, Date.now(), id);
  }

  failMemoryMaintenanceJob(id: number, error: string, retryDelayMs = 60_000): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE memory_maintenance_jobs SET
           status = 'pending',
           last_error = ?,
           available_at = ?,
           claimed_at = NULL,
           worker_id = NULL,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(error, now + retryDelayMs, now, id);
  }

  pendingMemoryMaintenanceJobs(limit = 50): MemoryMaintenanceJob[] {
    const rows = this.db
      .prepare(
        `SELECT id, type, memory_id AS memoryId, payload_json AS payloadJson,
                status, attempts, available_at AS availableAt, claimed_at AS claimedAt,
                worker_id AS workerId, last_error AS lastError,
                created_at AS createdAt, updated_at AS updatedAt
         FROM memory_maintenance_jobs
         WHERE status = 'pending'
         ORDER BY id ASC LIMIT ?`,
      )
      .all(limit) as RawMaintenanceJobRow[];
    return rows.map(toMaintenanceJob);
  }

  // ---- ConversationStore ----

  newConversation(): number {
    const info = this.db
      .prepare("INSERT INTO conversations(started_at) VALUES (?)")
      .run(Date.now());
    return Number(info.lastInsertRowid);
  }

  logTurn(convId: number, role: string, content: string, toolCallsJson: string | null = null): void {
    this.db
      .prepare(
        "INSERT INTO messages(conv_id, role, content, tool_calls_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(convId, role, content, toolCallsJson, Date.now());
  }

  recentMessages(convId: number, limit: number): MessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, conv_id AS convId, role, content, tool_calls_json AS toolCallsJson, created_at AS createdAt
         FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(convId, limit) as MessageRecord[];
    return rows.reverse();
  }

  listConversations(limit = 20): ConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT
           c.id AS id,
           c.started_at AS startedAt,
           COALESCE(MAX(m.created_at), c.started_at) AS lastActivityAt,
           COUNT(m.id) AS messageCount
         FROM conversations c
         LEFT JOIN messages m ON m.conv_id = c.id
         GROUP BY c.id, c.started_at
         ORDER BY lastActivityAt DESC, c.id DESC
         LIMIT ?`,
      )
      .all(limit) as ConversationSummary[];
    return rows;
  }

  loadConversation(convId: number): MessageRecord[] {
    return this.db
      .prepare(
        `SELECT id, conv_id AS convId, role, content, tool_calls_json AS toolCallsJson, created_at AS createdAt
         FROM messages WHERE conv_id = ? ORDER BY id ASC`,
      )
      .all(convId) as MessageRecord[];
  }

  // ---- AuditSink ----

  logToolCall(skill: string, argsJson: string, resultSummary: string, ok: boolean): void {
    this.db
      .prepare(
        "INSERT INTO audit_log(ts, skill, args_json, result_summary, ok) VALUES (?, ?, ?, ?, ?)",
      )
      .run(Date.now(), skill, argsJson, resultSummary, ok ? 1 : 0);
  }

  // ---- SessionStore ----

  findOrCreateSession(channel: string, conversationId: number, agent = "default"): SessionRecord {
    const existing = this.db
      .prepare(
        `SELECT id, channel, agent, status, created_at AS createdAt,
                last_activity_at AS lastActivityAt, conversation_id AS conversationId
         FROM sessions WHERE channel = ? AND status = 'active'
         ORDER BY last_activity_at DESC LIMIT 1`,
      )
      .get(channel) as SessionRecord | undefined;
    if (existing) return existing;
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions(id, channel, agent, status, created_at, last_activity_at, conversation_id)
         VALUES (?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(id, channel, agent, now, now, conversationId);
    return {
      id,
      channel,
      agent,
      status: "active",
      createdAt: now,
      lastActivityAt: now,
      conversationId,
    };
  }

  endSession(id: string): void {
    this.db.prepare("UPDATE sessions SET status = 'ended' WHERE id = ?").run(id);
  }

  touchSession(id: string): void {
    this.db
      .prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  listSessions(limit = 50): SessionRecord[] {
    return this.db
      .prepare(
        `SELECT id, channel, agent, status, created_at AS createdAt,
                last_activity_at AS lastActivityAt, conversation_id AS conversationId
         FROM sessions ORDER BY last_activity_at DESC LIMIT ?`,
      )
      .all(limit) as SessionRecord[];
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, channel, agent, status, created_at AS createdAt,
                last_activity_at AS lastActivityAt, conversation_id AS conversationId
         FROM sessions WHERE id = ?`,
      )
      .get(id) as SessionRecord | undefined;
    return row ?? null;
  }

  // ---- CronStore ----

  addCron(
    name: string,
    prompt: string,
    schedule: string,
    nextRunAt: number,
    channel: string | null = null,
  ): CronJobRecord {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO cron_jobs(channel, name, prompt, schedule, last_run_at, next_run_at, status, created_at)
         VALUES (?, ?, ?, ?, 0, ?, 'active', ?)`,
      )
      .run(channel, name, prompt, schedule, nextRunAt, now);
    return {
      id: Number(info.lastInsertRowid),
      channel,
      name,
      prompt,
      schedule,
      lastRunAt: 0,
      nextRunAt,
      status: "active",
      createdAt: now,
    };
  }

  listCron(): CronJobRecord[] {
    return this.db
      .prepare(
        `SELECT id, channel, name, prompt, schedule, last_run_at AS lastRunAt,
                next_run_at AS nextRunAt, status, created_at AS createdAt
         FROM cron_jobs ORDER BY id ASC`,
      )
      .all() as CronJobRecord[];
  }

  getCron(id: number): CronJobRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, channel, name, prompt, schedule, last_run_at AS lastRunAt,
                next_run_at AS nextRunAt, status, created_at AS createdAt
         FROM cron_jobs WHERE id = ?`,
      )
      .get(id) as CronJobRecord | undefined;
    return row ?? null;
  }

  removeCron(id: number): void {
    this.db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
  }

  setCronPaused(id: number, paused: boolean): void {
    this.db
      .prepare("UPDATE cron_jobs SET status = ? WHERE id = ?")
      .run(paused ? "paused" : "active", id);
  }

  markCronRan(id: number, ranAt: number, nextRunAt: number): void {
    this.db
      .prepare("UPDATE cron_jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?")
      .run(ranAt, nextRunAt, id);
  }

  /**
   * Cheap rollup over the audit log for `/usage`. Returns counts and a
   * by-skill breakdown so the slash command can render a quick summary
   * without the gateway maintaining its own metrics table.
   */
  auditUsage(sinceMs?: number): { total: number; ok: number; failed: number; bySkill: Array<{ skill: string; count: number }> } {
    const cutoff = sinceMs ?? 0;
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok,
                SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed
         FROM audit_log WHERE ts >= ?`,
      )
      .get(cutoff) as { total: number; ok: number | null; failed: number | null };
    const bySkill = this.db
      .prepare(
        `SELECT skill, COUNT(*) AS count
         FROM audit_log WHERE ts >= ?
         GROUP BY skill ORDER BY count DESC`,
      )
      .all(cutoff) as Array<{ skill: string; count: number }>;
    return {
      total: totals.total ?? 0,
      ok: totals.ok ?? 0,
      failed: totals.failed ?? 0,
      bySkill,
    };
  }

  recordLLMUsage(record: LLMUsageRecord): void {
    const usage = record.usage ?? {};
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO llm_usage_events(
             ts, provider, model, role, kind,
             task_kind, task_name, channel, session_id, conversation_id, component,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.ts ?? Date.now(),
          record.provider,
          record.model,
          record.role,
          record.kind,
          record.context?.taskKind ?? "unknown",
          record.context?.taskName ?? null,
          record.context?.channel ?? null,
          record.context?.sessionId ?? null,
          record.context?.conversationId ?? null,
          record.context?.component ?? null,
          nullableInt(usage.inputTokens),
          nullableInt(usage.outputTokens),
          nullableInt(usage.cacheReadTokens),
          nullableInt(usage.cacheWriteTokens),
        );
      this.refreshLLMUsageWikiPage();
    });
    tx();
  }

  private refreshLLMUsageWikiPage(): void {
    this.upsertWikiPageInternal(
      {
        path: LLM_USAGE_PAGE_PATH,
        folder: "system",
        title: "LLM Usage",
        content: this.renderLLMUsageWikiPage(),
        tags: ["system", "llm", "usage", "statistics"],
        sourceMemoryIds: [],
      },
      { allowProtected: true },
    );
  }

  private renderLLMUsageWikiPage(): string {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS inputTokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS outputTokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cacheReadTokens,
                COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cacheWriteTokens,
                SUM(CASE WHEN input_tokens IS NULL
                          AND output_tokens IS NULL
                          AND cache_read_tokens IS NULL
                          AND cache_write_tokens IS NULL
                         THEN 1 ELSE 0 END) AS callsWithoutTokenData,
                SUM(CASE WHEN kind = 'error' THEN 1 ELSE 0 END) AS errorCalls,
                MIN(ts) AS firstTs,
                MAX(ts) AS lastTs
         FROM llm_usage_events`,
      )
      .get() as LLMUsageTotalsRow;
    const byTask = this.db
      .prepare(
        `SELECT task_kind AS taskKind, COUNT(*) AS calls,
                COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS inputTokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS outputTokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cacheReadTokens,
                COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cacheWriteTokens
         FROM llm_usage_events
         GROUP BY task_kind
         ORDER BY calls DESC, task_kind ASC`,
      )
      .all() as LLMUsageByTaskRow[];
    const byModel = this.db
      .prepare(
        `SELECT role, provider, model, COUNT(*) AS calls,
                COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS inputTokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS outputTokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cacheReadTokens,
                COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cacheWriteTokens
         FROM llm_usage_events
         GROUP BY role, provider, model
         ORDER BY role ASC, calls DESC, provider ASC, model ASC`,
      )
      .all() as LLMUsageByModelRow[];
    const byTaskModel = this.db
      .prepare(
        `SELECT task_kind AS taskKind, role, provider, model, COUNT(*) AS calls,
                COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS inputTokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS outputTokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cacheReadTokens,
                COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cacheWriteTokens
         FROM llm_usage_events
         GROUP BY task_kind, role, provider, model
         ORDER BY task_kind ASC, role ASC, calls DESC, provider ASC, model ASC`,
      )
      .all() as LLMUsageByTaskModelRow[];
    const byChannel = this.db
      .prepare(
        `SELECT COALESCE(channel, '') AS channel,
                task_kind AS taskKind,
                COALESCE(task_name, '') AS taskName,
                COUNT(*) AS calls,
                COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS inputTokens,
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0) AS outputTokens,
                COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cacheReadTokens,
                COALESCE(SUM(COALESCE(cache_write_tokens, 0)), 0) AS cacheWriteTokens
         FROM llm_usage_events
         GROUP BY channel, task_kind, task_name
         ORDER BY calls DESC, channel ASC, task_kind ASC
         LIMIT 50`,
      )
      .all() as LLMUsageByChannelRow[];
    const recent = this.db
      .prepare(
        `SELECT ts, role, provider, model, kind,
                task_kind AS taskKind,
                task_name AS taskName,
                channel,
                session_id AS sessionId,
                conversation_id AS conversationId,
                component,
                input_tokens AS inputTokens,
                output_tokens AS outputTokens,
                cache_read_tokens AS cacheReadTokens,
                cache_write_tokens AS cacheWriteTokens
         FROM llm_usage_events
         ORDER BY ts DESC, id DESC
         LIMIT 10`,
      )
      .all() as LLMUsageRecentRow[];
    const totalTokens =
      Number(totals.inputTokens ?? 0) +
      Number(totals.outputTokens ?? 0) +
      Number(totals.cacheReadTokens ?? 0) +
      Number(totals.cacheWriteTokens ?? 0);

    return [
      "# LLM Usage",
      "",
      "Protected system page. This page is generated by miniclaw from local SQLite usage events.",
      "It is for the user only: normal wiki search/read/list and context retrieval do not expose it to the LLM.",
      "The LLM wiki maintainer cannot modify this page.",
      "",
      `Updated: ${formatTimestamp(Date.now())}`,
      `First event: ${totals.firstTs ? formatTimestamp(totals.firstTs) : "none"}`,
      `Last event: ${totals.lastTs ? formatTimestamp(totals.lastTs) : "none"}`,
      "",
      "## Totals",
      "",
      "| Metric | Value |",
      "|---|---:|",
      `| Calls | ${formatInt(totals.calls)} |`,
      `| Error calls | ${formatInt(totals.errorCalls)} |`,
      `| Calls without token data | ${formatInt(totals.callsWithoutTokenData)} |`,
      `| Input tokens | ${formatInt(totals.inputTokens)} |`,
      `| Output tokens | ${formatInt(totals.outputTokens)} |`,
      `| Cache read tokens | ${formatInt(totals.cacheReadTokens)} |`,
      `| Cache write tokens | ${formatInt(totals.cacheWriteTokens)} |`,
      `| All reported tokens | ${formatInt(totalTokens)} |`,
      "",
      "## By Task",
      "",
      byTask.length
        ? [
            "| Task | Calls | Input | Output | Cache read | Cache write |",
            "|---|---:|---:|---:|---:|---:|",
            ...byTask.map((row) =>
              `| ${md(formatTaskKind(row.taskKind))} | ${formatInt(row.calls)} | ` +
              `${formatInt(row.inputTokens)} | ${formatInt(row.outputTokens)} | ` +
              `${formatInt(row.cacheReadTokens)} | ${formatInt(row.cacheWriteTokens)} |`,
            ),
          ].join("\n")
        : "_No LLM calls recorded yet._",
      "",
      "## By Role And Model",
      "",
      byModel.length
        ? [
            "| Role | Provider | Model | Calls | Input | Output | Cache read | Cache write |",
            "|---|---|---|---:|---:|---:|---:|---:|",
            ...byModel.map((row) =>
              `| ${md(row.role)} | ${md(row.provider)} | ${md(row.model)} | ${formatInt(row.calls)} | ` +
              `${formatInt(row.inputTokens)} | ${formatInt(row.outputTokens)} | ` +
              `${formatInt(row.cacheReadTokens)} | ${formatInt(row.cacheWriteTokens)} |`,
            ),
          ].join("\n")
        : "_No LLM calls recorded yet._",
      "",
      "## By Task, Role, And Model",
      "",
      byTaskModel.length
        ? [
            "| Task | Role | Provider | Model | Calls | Input | Output | Cache read | Cache write |",
            "|---|---|---|---|---:|---:|---:|---:|---:|",
            ...byTaskModel.map((row) =>
              `| ${md(formatTaskKind(row.taskKind))} | ${md(row.role)} | ${md(row.provider)} | ${md(row.model)} | ` +
              `${formatInt(row.calls)} | ${formatInt(row.inputTokens)} | ${formatInt(row.outputTokens)} | ` +
              `${formatInt(row.cacheReadTokens)} | ${formatInt(row.cacheWriteTokens)} |`,
            ),
          ].join("\n")
        : "_No LLM calls recorded yet._",
      "",
      "## By Channel Or Job",
      "",
      byChannel.length
        ? [
            "| Channel / job | Task | Label | Calls | Input | Output | Cache read | Cache write |",
            "|---|---|---|---:|---:|---:|---:|---:|",
            ...byChannel.map((row) =>
              `| ${md(formatChannel(row.channel))} | ${md(formatTaskKind(row.taskKind))} | ` +
              `${md(row.taskName || "-")} | ${formatInt(row.calls)} | ${formatInt(row.inputTokens)} | ` +
              `${formatInt(row.outputTokens)} | ${formatInt(row.cacheReadTokens)} | ` +
              `${formatInt(row.cacheWriteTokens)} |`,
            ),
          ].join("\n")
        : "_No channel-attributed calls recorded yet._",
      "",
      "## Recent Calls",
      "",
      recent.length
        ? [
            "| Time | Task | Label | Channel | Session | Conversation | Component | Role | Provider | Model | Kind | Input | Output | Cache read | Cache write |",
            "|---|---|---|---|---|---:|---|---|---|---|---|---:|---:|---:|---:|",
            ...recent.map((row) =>
              `| ${md(formatTimestamp(row.ts))} | ${md(formatTaskKind(row.taskKind))} | ` +
              `${md(row.taskName ?? "-")} | ${md(formatChannel(row.channel ?? ""))} | ` +
              `${md(row.sessionId ?? "-")} | ${formatOptionalInt(row.conversationId)} | ${md(row.component ?? "-")} | ` +
              `${md(row.role)} | ${md(row.provider)} | ${md(row.model)} | ${md(row.kind)} | ` +
              `${formatInt(row.inputTokens)} | ${formatInt(row.outputTokens)} | ` +
              `${formatInt(row.cacheReadTokens)} | ${formatInt(row.cacheWriteTokens)} |`,
            ),
          ].join("\n")
        : "_No recent calls._",
    ].join("\n");
  }

  cronDueNow(now: number): CronJobRecord[] {
    return this.db
      .prepare(
        `SELECT id, channel, name, prompt, schedule, last_run_at AS lastRunAt,
                next_run_at AS nextRunAt, status, created_at AS createdAt
         FROM cron_jobs
         WHERE status = 'active' AND next_run_at <= ?
         ORDER BY next_run_at ASC`,
      )
      .all(now) as CronJobRecord[];
  }

  // ---- ChannelAllowlist ----

  isAllowed(channel: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS hit FROM channel_allowlist WHERE channel = ?")
      .get(channel) as { hit: number } | undefined;
    return !!row;
  }

  allowChannel(channel: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO channel_allowlist(channel, created_at) VALUES (?, ?)")
      .run(channel, Date.now());
  }

  disallowChannel(channel: string): void {
    this.db.prepare("DELETE FROM channel_allowlist WHERE channel = ?").run(channel);
  }

  listAllowed(): string[] {
    const rows = this.db
      .prepare("SELECT channel FROM channel_allowlist ORDER BY created_at DESC")
      .all() as Array<{ channel: string }>;
    return rows.map((r) => r.channel);
  }

  // ---- PairingStore ----

  mintPairing(channel: string, ttlMs = 120 * 60_000): PairingRecord {
    // Invalidate any prior unredeemed code for this channel so the new
    // one is the only valid token.
    this.db.prepare("DELETE FROM pairing_codes WHERE channel = ?").run(channel);
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const code = generatePairingCode();
    this.db
      .prepare(
        "INSERT INTO pairing_codes(code, channel, expires_at, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(code, channel, expiresAt, now);
    return { code, channel, expiresAt };
  }

  redeemPairing(code: string): string | null {
    const now = Date.now();
    // Lazily expire stale codes so the table doesn't grow forever.
    this.db.prepare("DELETE FROM pairing_codes WHERE expires_at < ?").run(now);
    const row = this.db
      .prepare("SELECT channel FROM pairing_codes WHERE code = ?")
      .get(code) as { channel: string } | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM pairing_codes WHERE code = ?").run(code);
    return row.channel;
  }

  close(): void {
    this.db.close();
  }
}

function sqliteNativeDependencyMessage(err: unknown): string {
  const msg = (err as Error).message ?? String(err);
  if (
    /Could not locate the bindings file|NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|better_sqlite3\.node/i.test(
      msg,
    )
  ) {
    return (
      "better-sqlite3 native binding is not usable for the current Node.js runtime. " +
      "Run `pnpm install` from the repo root. If you recently changed Node versions, " +
      "remove `node_modules` and run `pnpm install` again, or rebuild better-sqlite3 " +
      "with the same `node` binary used by `pnpm dev`. Original error: " +
      msg
    );
  }
  return msg;
}

// 8 uppercase chars from a no-ambiguous alphabet ("I", "1", "O", "0"
// removed). Short enough for the user to type accurately from a DM.
function generatePairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

interface RawMemoryRow {
  id: number;
  kind: string;
  content: string;
  tags: string;
  createdAt: number;
  folder?: string | null;
  status?: MemoryStatus | null;
  canonicalPagePath?: string | null;
}

function toMemoryRecord(row: RawMemoryRow): MemoryRecord {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    tags: row.tags ? row.tags.split(/\s+/).filter(Boolean) : [],
    createdAt: row.createdAt,
    folder: row.folder ?? "inbox",
    status: row.status ?? "active",
    canonicalPagePath: row.canonicalPagePath ?? null,
  };
}

interface RawWikiPageRow {
  path: string;
  folder: string;
  title: string;
  content: string;
  tags: string;
  sourceMemoryIds: string;
  createdAt: number;
  updatedAt: number;
}

interface RawWikiSearchRow {
  path: string;
  folder: string;
  title: string;
  content: string;
  tags: string;
  sourceMemoryIds: string;
}

function toWikiPageRecord(row: RawWikiPageRow): WikiPageRecord {
  return {
    path: row.path,
    folder: row.folder,
    title: row.title,
    content: row.content,
    tags: splitTags(row.tags),
    sourceMemoryIds: parseNumberArray(row.sourceMemoryIds),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toWikiSearchResult(row: RawWikiSearchRow): WikiSearchResult {
  return {
    path: row.path,
    folder: row.folder,
    title: row.title,
    content: row.content,
    tags: splitTags(row.tags),
    sourceMemoryIds: parseNumberArray(row.sourceMemoryIds),
  };
}

interface RawMaintenanceJobRow {
  id: number;
  type: string;
  memoryId: number | null;
  payloadJson: string;
  status: "pending" | "running" | "completed" | "failed";
  attempts: number;
  availableAt: number;
  claimedAt: number | null;
  workerId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface LLMUsageTotalsRow {
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  callsWithoutTokenData: number | null;
  errorCalls: number | null;
  firstTs: number | null;
  lastTs: number | null;
}

interface LLMUsageAggregateFields {
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

interface LLMUsageByTaskRow extends LLMUsageAggregateFields {
  taskKind: string;
}

interface LLMUsageByModelRow extends LLMUsageAggregateFields {
  role: string;
  provider: string;
  model: string;
}

interface LLMUsageByTaskModelRow extends LLMUsageByModelRow {
  taskKind: string;
}

interface LLMUsageByChannelRow extends LLMUsageAggregateFields {
  channel: string;
  taskKind: string;
  taskName: string;
}

interface LLMUsageRecentRow {
  ts: number;
  role: string;
  provider: string;
  model: string;
  kind: string;
  taskKind: string;
  taskName: string | null;
  channel: string | null;
  sessionId: string | null;
  conversationId: number | null;
  component: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

function toMaintenanceJob(row: RawMaintenanceJobRow): MemoryMaintenanceJob {
  return {
    id: row.id,
    type: row.type,
    memoryId: row.memoryId,
    payload: parseObject(row.payloadJson),
    status: row.status,
    attempts: row.attempts,
    availableAt: row.availableAt,
    claimedAt: row.claimedAt,
    workerId: row.workerId,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function folderFromWikiPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "inbox" : path.slice(0, i);
}

function titleFromPath(path: string): string {
  const last = path.split("/").filter(Boolean).at(-1) ?? path;
  return last.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
}

function isProtectedWikiPagePath(path: string): boolean {
  return PROTECTED_WIKI_PAGE_PATHS.has(path);
}

function nullableInt(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString();
}

function formatInt(value: number | null | undefined): string {
  return String(value ?? 0);
}

function formatOptionalInt(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : String(value);
}

function formatTaskKind(taskKind: string): string {
  switch (taskKind) {
    case "user_message":
      return "Actual messages";
    case "cron":
      return "Cron jobs";
    case "compaction":
      return "Context compaction";
    case "wiki_maintenance":
      return "Wiki maintenance";
    case "dream":
      return "Dreaming";
    case "tool_security":
      return "Tool security";
    case "unknown":
      return "Unknown";
    default:
      return taskKind.replace(/_/g, " ");
  }
}

function formatChannel(channel: string): string {
  if (!channel) return "-";
  const cron = /^cron:(\d+):(\d+)/.exec(channel);
  if (cron?.[1]) return `cron #${cron[1]}`;
  if (channel.startsWith("discord:dm:")) return "Discord DM";
  return channel;
}

function md(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function splitTags(tags: string): string[] {
  return tags ? tags.split(/\s+/).filter(Boolean) : [];
}

function parseNumberArray(json: string): number[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((n): n is number => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function isMemoryStatus(v: string): v is MemoryStatus {
  return v === "active" || v === "duplicate" || v === "superseded" || v === "retired";
}

// FTS5 MATCH is unforgiving — bare punctuation throws. Reduce a user query
// to quoted tokens so any input is treatable as a phrase-OR of terms.
function sanitizeFtsQuery(q: string): string {
  const tokens = q.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}
