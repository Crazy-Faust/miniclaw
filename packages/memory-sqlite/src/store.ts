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

// Single SQLite file implements three contracts. A future split (e.g.
// audit-postgres) only needs to keep its slice of these methods.
export class SqliteStore
  implements
    MemoryStore,
    WikiStore,
    KnowledgeStore,
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
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_metadata(memory_id, folder_path, status, updated_at)
         SELECT id, 'inbox', 'active', created_at FROM memories`,
      )
      .run();
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
    const path = normalizeWikiPagePath(input.path, input.folder);
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
    const row = this.db
      .prepare(
        `SELECT path, folder_path AS folder, title, content, tags,
                source_memory_ids AS sourceMemoryIds, created_at AS createdAt, updated_at AS updatedAt
         FROM wiki_pages WHERE path = ?`,
      )
      .get(normalized) as RawWikiPageRow | undefined;
    return row ? toWikiPageRecord(row) : null;
  }

  listWikiPages(folder?: string, limit = 50): WikiPageRecord[] {
    const normalizedFolder = folder ? normalizeMemoryFolderPath(folder) : null;
    const rows = this.db
      .prepare(
        `SELECT path, folder_path AS folder, title, content, tags,
                source_memory_ids AS sourceMemoryIds, created_at AS createdAt, updated_at AS updatedAt
         FROM wiki_pages
         WHERE ? IS NULL OR folder_path = ?
         ORDER BY updated_at DESC, path ASC
         LIMIT ?`,
      )
      .all(normalizedFolder, normalizedFolder, limit) as RawWikiPageRow[];
    return rows.map(toWikiPageRecord);
  }

  listWikiFolders(): WikiFolderRecord[] {
    return this.db
      .prepare(
        `SELECT path, title, created_at AS createdAt, updated_at AS updatedAt
         FROM wiki_folders ORDER BY path ASC`,
      )
      .all() as WikiFolderRecord[];
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
             ORDER BY rank
             LIMIT ?`,
          )
          .all(sanitized, limit) as RawWikiSearchRow[]
      : this.db
          .prepare(
            `SELECT path, folder_path AS folder, title, content, tags,
                    source_memory_ids AS sourceMemoryIds
             FROM wiki_pages ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(limit) as RawWikiSearchRow[];
    return rows.map(toWikiSearchResult);
  }

  addWikiLink(fromPath: string, toPath: string, kind = "related"): void {
    const from = normalizeWikiPagePath(fromPath);
    const to = normalizeWikiPagePath(toPath);
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
          case "upsert_page":
            this.upsertWikiPage(action);
            break;
          case "add_link":
            this.addWikiLink(action.fromPath, action.toPath, action.kind);
            break;
          case "mark_memory":
            this.updateMemoryMetadata(action.memoryId, {
              folder: action.folder,
              status: action.status,
              canonicalPagePath: action.canonicalPagePath,
            });
            break;
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
