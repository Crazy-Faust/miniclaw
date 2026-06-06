import { describe, expect, it } from "vitest";
import type { Agent } from "@miniclaw/agent";
import { Gateway } from "@miniclaw/gateway";
import type { AuditSink, MemoryStore, SkillContext } from "@miniclaw/core";
import { createSessionsSkills } from "../src/skills.ts";

function makeStore() {
  const sessions: any[] = [];
  let cid = 0;
  let mid = 0;
  const messages: any[] = [];
  return {
    findOrCreateSession(channel: string, conversationId: number, agent = "default") {
      const existing = sessions.find((s) => s.channel === channel && s.status === "active");
      if (existing) return existing;
      const rec = {
        id: `sess-${sessions.length + 1}`, channel, agent, status: "active",
        createdAt: Date.now(), lastActivityAt: Date.now(), conversationId,
      };
      sessions.push(rec);
      return rec;
    },
    endSession(id: string) { const s = sessions.find((r) => r.id === id); if (s) s.status = "ended"; },
    touchSession(id: string) { const s = sessions.find((r) => r.id === id); if (s) s.lastActivityAt = Date.now(); },
    listSessions(limit = 50) { return sessions.slice(0, limit); },
    getSession(id: string) { return sessions.find((s) => s.id === id) ?? null; },
    newConversation() { return ++cid; },
    logTurn(convId: number, role: string, content: string) {
      messages.push({ id: ++mid, convId, role, content, toolCallsJson: null, createdAt: Date.now() });
    },
    recentMessages(convId: number, limit: number) {
      return messages.filter((m) => m.convId === convId).slice(-limit);
    },
    listConversations() { return []; },
    loadConversation() { return []; },
  };
}

function makeAgent(): Agent {
  return {
    async runTurn(userMsg: string) {
      return { toolCalls: [], finalText: `echo:${userMsg}` };
    },
  } as unknown as Agent;
}

// VULN-14: sessions_send ownership check
describe("sessions_send — ownership check (VULN-14)", () => {
  it("allows sending to a session on the same channel", async () => {
    const store = makeStore();
    const gw = new Gateway({ sessions: store, conversations: store, agentFor: () => makeAgent() });
    const s = gw.attach("cli");
    const skills = createSessionsSkills(gw);
    const send = skills.find((sk) => sk.name === "sessions_send")!;
    const ctx: SkillContext = {
      memory: {} as MemoryStore,
      audit: {} as AuditSink,
      dbPath: ":memory:",
      channel: "cli",
    };
    const res = await send.execute({ sessionId: s.record.id, message: "ping" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toBe("echo:ping");
  });

  it("rejects sending to a session on a different channel", async () => {
    const store = makeStore();
    const gw = new Gateway({ sessions: store, conversations: store, agentFor: () => makeAgent() });
    const target = gw.attach("discord:dm:other-user");
    const skills = createSessionsSkills(gw);
    const send = skills.find((sk) => sk.name === "sessions_send")!;
    const ctx: SkillContext = {
      memory: {} as MemoryStore,
      audit: {} as AuditSink,
      dbPath: ":memory:",
      channel: "cli",
    };
    const res = await send.execute({ sessionId: target.record.id, message: "evil" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/refused/);
  });

  it("allows sending when ctx.channel is unset (backward-compat single-user mode)", async () => {
    const store = makeStore();
    const gw = new Gateway({ sessions: store, conversations: store, agentFor: () => makeAgent() });
    const s = gw.attach("discord:dm:123");
    const skills = createSessionsSkills(gw);
    const send = skills.find((sk) => sk.name === "sessions_send")!;
    const ctx: SkillContext = {
      memory: {} as MemoryStore,
      audit: {} as AuditSink,
      dbPath: ":memory:",
      // no channel set — single-user CLI mode
    };
    const res = await send.execute({ sessionId: s.record.id, message: "hi" }, ctx);
    expect(res.ok).toBe(true);
  });
});
