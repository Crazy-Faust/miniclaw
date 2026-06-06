import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent } from "@miniclaw/agent";
import { Gateway } from "../src/gateway.ts";
import { startSocketDaemon } from "../src/daemon.ts";

function makeStore() {
  const sessions: any[] = [];
  let cid = 0;
  return {
    sessions,
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
    logTurn() {},
    recentMessages() { return []; },
    listConversations() { return []; },
    loadConversation() { return []; },
  };
}

// VULN-13: Unix socket permissions
describe("startSocketDaemon — socket permissions (VULN-13)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-sock-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sets the socket parent directory to 0700", async () => {
    const socketDir = join(dir, "subdir");
    const socketPath = join(socketDir, "test.sock");
    const store = makeStore();
    const gw = new Gateway({
      sessions: store,
      conversations: store,
      agentFor: () => ({ async runTurn() { return { toolCalls: [], finalText: "ok" }; } } as unknown as Agent),
    });
    const handle = startSocketDaemon({ gateway: gw, socketPath });
    // Wait for the server to start listening
    await new Promise((resolve) => handle.server.once("listening", resolve));
    const dirStat = statSync(socketDir);
    // Check owner-only permissions (0700)
    expect(dirStat.mode & 0o777).toBe(0o700);
    await handle.stop();
  });

  it("sets the socket file to 0600 after binding", async () => {
    const socketPath = join(dir, "test.sock");
    const store = makeStore();
    const gw = new Gateway({
      sessions: store,
      conversations: store,
      agentFor: () => ({ async runTurn() { return { toolCalls: [], finalText: "ok" }; } } as unknown as Agent),
    });
    const handle = startSocketDaemon({ gateway: gw, socketPath });
    await new Promise((resolve) => handle.server.once("listening", resolve));
    const sockStat = statSync(socketPath);
    // Socket files have S_IFSOCK bit set; check permission bits only
    expect(sockStat.mode & 0o777).toBe(0o600);
    await handle.stop();
  });
});
