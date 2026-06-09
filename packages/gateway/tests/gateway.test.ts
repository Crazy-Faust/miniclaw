import { describe, expect, it } from "vitest";
import type { Agent } from "@miniclaw/agent";
import type { CronJobRecord } from "@miniclaw/core";
import { Gateway } from "../src/gateway.ts";
import { CronScheduler, isOneShotSchedule, parseSchedule } from "../src/cron.ts";

// Minimal fake store satisfying SessionStore + ConversationStore.
function makeStore() {
  const sessions: any[] = [];
  const convs: any[] = [];
  const messages: any[] = [];
  const cronJobs: CronJobRecord[] = [];
  let cid = 0;
  let mid = 0;
  let cronId = 0;
  return {
    sessions,
    convs,
    messages,
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
    endSession(id: string) {
      const s = sessions.find((r) => r.id === id);
      if (s) s.status = "ended";
    },
    touchSession(id: string) {
      const s = sessions.find((r) => r.id === id);
      if (s) s.lastActivityAt = Date.now();
    },
    listSessions(limit = 50) { return sessions.slice(0, limit); },
    getSession(id: string) { return sessions.find((s) => s.id === id) ?? null; },
    newConversation() {
      const id = ++cid;
      convs.push({ id, startedAt: Date.now() });
      return id;
    },
    logTurn(convId: number, role: string, content: string) {
      messages.push({ id: ++mid, convId, role, content, toolCallsJson: null, createdAt: Date.now() });
    },
    recentMessages(convId: number, limit: number) {
      return messages.filter((m) => m.convId === convId).slice(-limit);
    },
    listConversations() { return []; },
    loadConversation() { return []; },
    addCron(
      name: string,
      prompt: string,
      schedule: string,
      nextRunAt: number,
      channel: string | null = null,
    ) {
      const rec: CronJobRecord = {
        id: ++cronId,
        name,
        prompt,
        schedule,
        nextRunAt,
        lastRunAt: 0,
        status: "active",
        channel,
        createdAt: Date.now(),
      };
      cronJobs.push(rec);
      return rec;
    },
    listCron() {
      return [...cronJobs];
    },
    getCron(id: number) {
      return cronJobs.find((r) => r.id === id) ?? null;
    },
    removeCron(id: number) {
      const before = cronJobs.length;
      const idx = cronJobs.findIndex((r) => r.id === id);
      if (idx >= 0) cronJobs.splice(idx, 1);
      return cronJobs.length !== before;
    },
    setCronPaused(id: number, paused: boolean) {
      const rec = cronJobs.find((r) => r.id === id);
      if (rec) rec.status = paused ? "paused" : "active";
    },
    cronDueNow(now: number) {
      return cronJobs.filter((r) => r.status === "active" && r.nextRunAt <= now);
    },
    markCronRan(id: number, ranAt: number, nextRunAt: number) {
      const rec = cronJobs.find((r) => r.id === id);
      if (!rec) return false;
      rec.lastRunAt = ranAt;
      rec.nextRunAt = nextRunAt;
      return true;
    },
  };
}

function makeAgent(): Agent {
  return {
    async runTurn(userMsg: string) {
      return { toolCalls: [], finalText: `echo:${userMsg}` };
    },
  } as unknown as Agent;
}

describe("Gateway", () => {
  it("creates one session per channel", async () => {
    const store = makeStore();
    const agent = makeAgent();
    const gw = new Gateway({
      sessions: store,
      conversations: store,
      agentFor: () => agent,
    });

    const a = gw.attach("cli");
    const b = gw.attach("cli");
    expect(a.record.id).toBe(b.record.id);

    const c = gw.attach("telegram:42");
    expect(c.record.id).not.toBe(a.record.id);
  });

  it("dispatches a turn through the agent and touches the session", async () => {
    const store = makeStore();
    const gw = new Gateway({
      sessions: store,
      conversations: store,
      agentFor: () => makeAgent(),
    });
    const s = gw.attach("cli");
    const beforeTouch = s.record.lastActivityAt;
    await new Promise((r) => setTimeout(r, 5));
    const trace = await s.send("hi");
    expect(trace.finalText).toBe("echo:hi");
    expect(store.getSession(s.record.id)!.lastActivityAt).toBeGreaterThan(beforeTouch);
  });

  it("spawn() always creates a new session even for an existing channel", () => {
    const store = makeStore();
    const gw = new Gateway({
      sessions: store,
      conversations: store,
      agentFor: () => makeAgent(),
    });
    const a = gw.attach("cli");
    const b = gw.spawn("cli");
    expect(b.record.id).not.toBe(a.record.id);
  });

  it("end() marks a session ended; later attach makes a new one", () => {
    const store = makeStore();
    const gw = new Gateway({
      sessions: store,
      conversations: store,
      agentFor: () => makeAgent(),
    });
    const a = gw.attach("cli");
    gw.end(a.record.id);
    const b = gw.attach("cli");
    expect(b.record.id).not.toBe(a.record.id);
  });
});

describe("parseSchedule", () => {
  it("parses @every dialect", () => {
    expect(parseSchedule("@every 30s")).toBe(30_000);
    expect(parseSchedule("@every 5m")).toBe(300_000);
    expect(parseSchedule("@every 1h")).toBe(3_600_000);
    expect(parseSchedule("@every 1d")).toBe(86_400_000);
  });
  it("rejects unsupported expressions", () => {
    expect(() => parseSchedule("* * * * *")).toThrow();
    expect(() => parseSchedule("@every banana")).toThrow();
  });

  it("recognizes @once as a one-shot schedule", () => {
    expect(isOneShotSchedule("@once")).toBe(true);
    expect(parseSchedule("@once")).toBe(0);
  });
});

describe("CronScheduler", () => {
  it("fires one-shot jobs on their stored channel, removes them, and emits final text", async () => {
    const store = makeStore();
    const gateway = new Gateway({
      sessions: store,
      conversations: store,
      agentFor: () => makeAgent(),
    });
    store.addCron("trash", "remind trash", "@once", 1000, "discord:dm:u1");
    const delivered: Array<{ channel: string; text: string }> = [];
    const scheduler = new CronScheduler({
      store,
      gateway,
      now: () => 2000,
      onResult: (_job, channel, text) => {
        delivered.push({ channel, text });
      },
    });

    await scheduler.tick();

    expect(store.listCron()).toHaveLength(0);
    expect(delivered).toEqual([{ channel: "discord:dm:u1", text: "echo:remind trash" }]);
    expect(store.listSessions()[0]!.channel).toBe("discord:dm:u1");
  });
});
