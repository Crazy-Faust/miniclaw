import { describe, expect, it } from "vitest";
import type { Agent } from "@miniclaw/agent";
import { Gateway } from "@miniclaw/gateway";
import type { AuditSink, MemoryStore, SkillContext } from "@miniclaw/core";
import { createSessionsSkills } from "../skills/sessions/handler.ts";

function makeStore() {
  const sessions: any[] = [];
  const convs: any[] = [];
  const messages: any[] = [];
  let cid = 0;
  let mid = 0;
  return {
    findOrCreateSession(channel: string, conversationId: number, agent = "default") {
      const existing = sessions.find((s) => s.channel === channel && s.status === "active");
      if (existing) return existing;
      const rec = {
        id: `sess-${sessions.length + 1}`,
        channel,
        agent,
        status: "active",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        conversationId,
      };
      sessions.push(rec);
      return rec;
    },
    endSession(id: string) { const s = sessions.find((r) => r.id === id); if (s) s.status = "ended"; },
    touchSession(id: string) { const s = sessions.find((r) => r.id === id); if (s) s.lastActivityAt = Date.now(); },
    listSessions(limit = 50) { return sessions.slice(0, limit); },
    getSession(id: string) { return sessions.find((s) => s.id === id) ?? null; },
    newConversation() { const id = ++cid; convs.push({ id, startedAt: Date.now() }); return id; },
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

function makeCtx(): SkillContext {
  return {
    memory: {} as MemoryStore,
    audit: {} as AuditSink,
    dbPath: ":memory:",
  };
}

describe("sessions skills", () => {
  it("sessions_list returns a line per session", async () => {
    const store = makeStore();
    const gw = new Gateway({ sessions: store, conversations: store, agentFor: () => makeAgent() });
    gw.attach("a");
    gw.attach("b");
    const [list] = createSessionsSkills(gw);
    const res = await list!.execute({ limit: 10 }, makeCtx());
    expect(res.ok).toBe(true);
    expect(res.output.split("\n")).toHaveLength(2);
    expect(res.output).toContain("channel=a");
    expect(res.output).toContain("channel=b");
  });

  it("sessions_spawn creates and reports a fresh session", async () => {
    const store = makeStore();
    const gw = new Gateway({ sessions: store, conversations: store, agentFor: () => makeAgent() });
    const skills = createSessionsSkills(gw);
    const spawn = skills.find((s) => s.name === "sessions_spawn")!;
    const res = await spawn.execute({ channel: "cli", agent: "default" }, makeCtx());
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/created session/);
  });

  it("sessions_send dispatches into the named session and returns the final text", async () => {
    const store = makeStore();
    const gw = new Gateway({ sessions: store, conversations: store, agentFor: () => makeAgent() });
    const s = gw.attach("cli");
    const skills = createSessionsSkills(gw);
    const send = skills.find((sk) => sk.name === "sessions_send")!;
    const res = await send.execute({ sessionId: s.record.id, message: "ping" }, makeCtx());
    expect(res.ok).toBe(true);
    expect(res.output).toBe("echo:ping");
  });

  it("sessions_history returns (empty) when no messages logged", async () => {
    const store = makeStore();
    const gw = new Gateway({ sessions: store, conversations: store, agentFor: () => makeAgent() });
    const s = gw.attach("cli");
    const skills = createSessionsSkills(gw);
    const history = skills.find((sk) => sk.name === "sessions_history")!;
    const res = await history.execute({ sessionId: s.record.id, limit: 10 }, makeCtx());
    expect(res.ok).toBe(true);
    expect(res.output).toBe("(empty)");
  });
});
