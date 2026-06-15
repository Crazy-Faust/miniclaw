import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent } from "@miniclaw/agent";
import { Gateway } from "../src/gateway.ts";
import { startSocketDaemon, type SocketDaemonHandle } from "../src/daemon.ts";

// Minimal SessionStore + ConversationStore fake (mirrors the other gateway tests).
function makeStore() {
  const sessions: any[] = [];
  let cid = 0;
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
    logTurn() {},
    recentMessages() { return []; },
    listConversations() { return []; },
    loadConversation() { return []; },
  };
}

// Connect, send a single attach (with the given fresh flag), and resolve the
// session id from the "attached" reply.
function attachOnce(socketPath: string, fresh: boolean): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const sock: Socket = createConnection(socketPath);
    sock.setEncoding("utf8");
    sock.once("error", reject);
    let buf = "";
    sock.on("data", (chunk: string | Buffer) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.type === "attached") {
          sock.end();
          resolve(String(msg.sessionId));
        }
      }
    });
    sock.once("connect", () => {
      sock.write(JSON.stringify({ type: "attach", channel: "cli", fresh }) + "\n");
    });
  });
}

describe("socket attach — fresh flag (Step 1.4)", () => {
  let dir: string;
  let socketPath: string;
  let handle: SocketDaemonHandle;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-attach-"));
    socketPath = join(dir, "test.sock");
    const store = makeStore();
    const gw = new Gateway({
      sessions: store,
      conversations: store,
      agentFor: () => ({ async runTurn() { return { toolCalls: [], finalText: "ok" }; } } as unknown as Agent),
    });
    handle = startSocketDaemon({ gateway: gw, socketPath });
    await new Promise((resolve) => handle.server.once("listening", resolve));
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("attach without fresh resumes the channel's active session", async () => {
    const a = await attachOnce(socketPath, false);
    const b = await attachOnce(socketPath, false);
    expect(b).toBe(a);
  });

  it("attach with fresh:true spawns a new session", async () => {
    const a = await attachOnce(socketPath, false);
    const b = await attachOnce(socketPath, true);
    expect(b).not.toBe(a);
  });
});
