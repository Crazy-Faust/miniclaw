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

interface AuditRow {
  id: number;
  ts: number;
  skill: string;
  argsJson: string;
  resultSummary: string;
  ok: boolean;
}

// Pure in-memory implementation. Search is a case-insensitive token AND
// match — same general feel as FTS5 for short content, but no stemming,
// no ranking. Good enough for tests and for running miniclaw without
// touching disk.
export class InMemoryStore
  implements
    MemoryStore,
    ConversationStore,
    AuditSink,
    SessionStore,
    CronStore,
    ChannelAllowlist,
    PairingStore
{
  private memSeq = 0;
  private convSeq = 0;
  private msgSeq = 0;
  private auditSeq = 0;
  private cronSeq = 0;

  private readonly memories: MemoryRecord[] = [];
  private readonly conversations: Array<{ id: number; startedAt: number }> = [];
  private readonly messages: MessageRecord[] = [];
  private readonly auditLog: AuditRow[] = [];
  private readonly sessions: SessionRecord[] = [];
  private readonly cronJobs: CronJobRecord[] = [];

  // ---- MemoryStore ----

  add(kind: string, content: string, tags: string[] = []): number {
    const id = ++this.memSeq;
    this.memories.push({ id, kind, content, tags: [...tags], createdAt: Date.now() });
    return id;
  }

  search(query: string, limit = 5): MemoryRecord[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return this.listRecent(limit);
    const scored: Array<{ rec: MemoryRecord; score: number }> = [];
    for (const rec of this.memories) {
      const hay = tokenize(rec.content + " " + rec.tags.join(" "));
      const matched = tokens.filter((t) => hay.includes(t)).length;
      if (matched > 0) scored.push({ rec, score: matched });
    }
    // Higher token-overlap first, ties broken by most recent.
    scored.sort((a, b) => b.score - a.score || b.rec.id - a.rec.id);
    return scored.slice(0, limit).map((s) => s.rec);
  }

  listRecent(limit: number): MemoryRecord[] {
    return [...this.memories].reverse().slice(0, limit);
  }

  // ---- ConversationStore ----

  newConversation(): number {
    const id = ++this.convSeq;
    this.conversations.push({ id, startedAt: Date.now() });
    return id;
  }

  logTurn(convId: number, role: string, content: string, toolCallsJson: string | null = null): void {
    this.messages.push({
      id: ++this.msgSeq,
      convId,
      role,
      content,
      toolCallsJson,
      createdAt: Date.now(),
    });
  }

  recentMessages(convId: number, limit: number): MessageRecord[] {
    const rows = this.messages.filter((m) => m.convId === convId);
    return rows.slice(-limit);
  }

  listConversations(limit = 20): ConversationSummary[] {
    const summaries: ConversationSummary[] = this.conversations.map((c) => {
      const msgs = this.messages.filter((m) => m.convId === c.id);
      const lastActivityAt = msgs.length === 0 ? c.startedAt : msgs[msgs.length - 1]!.createdAt;
      return {
        id: c.id,
        startedAt: c.startedAt,
        lastActivityAt,
        messageCount: msgs.length,
      };
    });
    summaries.sort((a, b) => b.lastActivityAt - a.lastActivityAt || b.id - a.id);
    return summaries.slice(0, limit);
  }

  loadConversation(convId: number): MessageRecord[] {
    return this.messages
      .filter((m) => m.convId === convId)
      .map((m) => ({ ...m }));
  }

  // ---- AuditSink ----

  logToolCall(skill: string, argsJson: string, resultSummary: string, ok: boolean): void {
    this.auditLog.push({
      id: ++this.auditSeq,
      ts: Date.now(),
      skill,
      argsJson,
      resultSummary,
      ok,
    });
  }

  // ---- SessionStore ----

  findOrCreateSession(channel: string, conversationId: number, agent = "default"): SessionRecord {
    const existing = this.sessions
      .filter((s) => s.channel === channel && s.status === "active")
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    if (existing) return existing;
    const now = Date.now();
    const rec: SessionRecord = {
      id: randomUUID(),
      channel,
      agent,
      status: "active",
      createdAt: now,
      lastActivityAt: now,
      conversationId,
    };
    this.sessions.push(rec);
    return rec;
  }

  endSession(id: string): void {
    const s = this.sessions.find((r) => r.id === id);
    if (s) s.status = "ended";
  }

  touchSession(id: string): void {
    const s = this.sessions.find((r) => r.id === id);
    if (s) s.lastActivityAt = Date.now();
  }

  listSessions(limit = 50): SessionRecord[] {
    return [...this.sessions]
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, limit)
      .map((s) => ({ ...s }));
  }

  getSession(id: string): SessionRecord | null {
    const s = this.sessions.find((r) => r.id === id);
    return s ? { ...s } : null;
  }

  // ---- CronStore ----

  addCron(
    name: string,
    prompt: string,
    schedule: string,
    nextRunAt: number,
    channel: string | null = null,
  ): CronJobRecord {
    const rec: CronJobRecord = {
      id: ++this.cronSeq,
      channel,
      name,
      prompt,
      schedule,
      lastRunAt: 0,
      nextRunAt,
      status: "active",
      createdAt: Date.now(),
    };
    this.cronJobs.push(rec);
    return { ...rec };
  }

  listCron(): CronJobRecord[] {
    return this.cronJobs.map((c) => ({ ...c }));
  }

  getCron(id: number): CronJobRecord | null {
    const c = this.cronJobs.find((r) => r.id === id);
    return c ? { ...c } : null;
  }

  removeCron(id: number): void {
    const i = this.cronJobs.findIndex((r) => r.id === id);
    if (i >= 0) this.cronJobs.splice(i, 1);
  }

  setCronPaused(id: number, paused: boolean): void {
    const c = this.cronJobs.find((r) => r.id === id);
    if (c) c.status = paused ? "paused" : "active";
  }

  markCronRan(id: number, ranAt: number, nextRunAt: number): void {
    const c = this.cronJobs.find((r) => r.id === id);
    if (c) {
      c.lastRunAt = ranAt;
      c.nextRunAt = nextRunAt;
    }
  }

  cronDueNow(now: number): CronJobRecord[] {
    return this.cronJobs
      .filter((c) => c.status === "active" && c.nextRunAt <= now)
      .sort((a, b) => a.nextRunAt - b.nextRunAt)
      .map((c) => ({ ...c }));
  }

  auditUsage(sinceMs?: number): { total: number; ok: number; failed: number; bySkill: Array<{ skill: string; count: number }> } {
    const cutoff = sinceMs ?? 0;
    const rows = this.auditLog.filter((r) => r.ts >= cutoff);
    const counts = new Map<string, number>();
    let ok = 0;
    let failed = 0;
    for (const r of rows) {
      counts.set(r.skill, (counts.get(r.skill) ?? 0) + 1);
      if (r.ok) ok++;
      else failed++;
    }
    const bySkill = [...counts.entries()]
      .map(([skill, count]) => ({ skill, count }))
      .sort((a, b) => b.count - a.count);
    return { total: rows.length, ok, failed, bySkill };
  }

  // ---- ChannelAllowlist ----

  private readonly allowed = new Set<string>();

  isAllowed(channel: string): boolean { return this.allowed.has(channel); }
  allowChannel(channel: string): void { this.allowed.add(channel); }
  disallowChannel(channel: string): void { this.allowed.delete(channel); }
  listAllowed(): string[] { return [...this.allowed]; }

  // ---- PairingStore ----

  private readonly pairings = new Map<string, { channel: string; expiresAt: number }>();

  mintPairing(channel: string, ttlMs = 120 * 60_000): PairingRecord {
    for (const [code, rec] of this.pairings) {
      if (rec.channel === channel) this.pairings.delete(code);
    }
    const code = generatePairingCode();
    const expiresAt = Date.now() + ttlMs;
    this.pairings.set(code, { channel, expiresAt });
    return { code, channel, expiresAt };
  }

  redeemPairing(code: string): string | null {
    const now = Date.now();
    for (const [k, rec] of this.pairings) {
      if (rec.expiresAt < now) this.pairings.delete(k);
    }
    const hit = this.pairings.get(code);
    if (!hit) return null;
    this.pairings.delete(code);
    return hit.channel;
  }

  // ---- Extras (not on the core interfaces — handy for introspection) ----

  /** Snapshot of the audit log. Read-only — mutations don't affect store state. */
  snapshotAudit(): AuditRow[] {
    return this.auditLog.map((r) => ({ ...r }));
  }

  close(): void {
    // No-op: nothing to release.
  }
}

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function generatePairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}
