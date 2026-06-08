import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import type {
  AuditSink,
  ChannelAllowlist,
  ConversationStore,
  ConversationSummary,
  CronJobRecord,
  CronStore,
  MemoryRecord,
  MemoryStore,
  MessageRecord,
  PairingRecord,
  PairingStore,
  SessionRecord,
  SessionStore,
} from "@miniclaw/core";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, "schema.sql"), "utf8");

// Single SQLite file implements three contracts. A future split (e.g.
// audit-postgres) only needs to keep its slice of these methods.
export class SqliteStore
  implements
    MemoryStore,
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
  }

  private migrate(): void {
    const cronCols = this.db.pragma("table_info(cron_jobs)") as Array<{ name: string }>;
    if (!cronCols.some((c) => c.name === "channel")) {
      this.db.exec("ALTER TABLE cron_jobs ADD COLUMN channel TEXT");
    }
  }

  // ---- MemoryStore ----

  add(kind: string, content: string, tags: string[] = []): number {
    const info = this.db
      .prepare("INSERT INTO memories(kind, content, tags, created_at) VALUES (?, ?, ?, ?)")
      .run(kind, content, tags.join(" "), Date.now());
    return Number(info.lastInsertRowid);
  }

  search(query: string, limit = 5): MemoryRecord[] {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return this.listRecent(limit);
    const rows = this.db
      .prepare(
        `SELECT m.id, m.kind, m.content, m.tags, m.created_at AS createdAt
         FROM memories_fts f
         JOIN memories m ON m.id = f.rowid
         WHERE memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(sanitized, limit) as RawMemoryRow[];
    return rows.map(toMemoryRecord);
  }

  listRecent(limit: number): MemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, content, tags, created_at AS createdAt
         FROM memories ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as RawMemoryRow[];
    return rows.map(toMemoryRecord);
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

  mintPairing(channel: string, ttlMs = 10 * 60_000): PairingRecord {
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
}

function toMemoryRecord(row: RawMemoryRow): MemoryRecord {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    tags: row.tags ? row.tags.split(/\s+/).filter(Boolean) : [],
    createdAt: row.createdAt,
  };
}

// FTS5 MATCH is unforgiving — bare punctuation throws. Reduce a user query
// to quoted tokens so any input is treatable as a phrase-OR of terms.
function sanitizeFtsQuery(q: string): string {
  const tokens = q.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}
