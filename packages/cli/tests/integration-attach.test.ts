import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@miniclaw/agent";
import {
  Gateway,
  defaultSocketPath,
  socketAttachIO,
  startSocketDaemon,
  type SocketDaemonHandle,
} from "@miniclaw/gateway";

import { ensureDaemon } from "../src/ensure-daemon.ts";

// End-to-end across the seam Phase 1 introduced, with a fake agent (no LLM):
// ensureDaemon() brings up a socket daemon, socketAttachIO() attaches in
// one-shot mode, runs a single turn, and prints the final answer.

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

describe("integration: ensureDaemon → attach → one turn → final", () => {
  let dir: string;
  let handle: SocketDaemonHandle | null;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-int-"));
    for (const k of ["MINICLAW_HOME", "MINICLAW_SOCKET", "MINICLAW_PID"]) saved[k] = process.env[k];
    process.env.MINICLAW_HOME = dir;
    process.env.MINICLAW_SOCKET = join(dir, "miniclaw.sock");
    process.env.MINICLAW_PID = join(dir, "miniclaw.pid");
    handle = null;
  });

  afterEach(async () => {
    if (handle) await handle.stop();
    for (const k of ["MINICLAW_HOME", "MINICLAW_SOCKET", "MINICLAW_PID"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("spawns (in-process), attaches, runs one user turn, prints the final answer", async () => {
    const store = makeStore();
    const gateway = new Gateway({
      sessions: store,
      conversations: store,
      agentFor: () =>
        ({ async runTurn(msg: string) { return { toolCalls: [], finalText: `echo:${msg}` }; } } as unknown as Agent),
    });

    // ensureDaemon's "spawn" step brings up the daemon in-process here instead
    // of forking a real `daemon run`.
    const socketPath = await ensureDaemon({
      preflight: () => {},
      timeoutMs: 3000,
      spawnDaemon: async () => {
        handle = startSocketDaemon({ gateway, socketPath: defaultSocketPath() });
        await new Promise((r) => handle!.server.once("listening", r));
      },
    });
    expect(socketPath).toBe(defaultSocketPath());

    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => { writes.push(String(chunk)); return true; });
    try {
      await socketAttachIO({ socketPath, channel: "cli", fresh: true, oneShot: "hello" });
    } finally {
      spy.mockRestore();
    }

    expect(writes.join("")).toContain("echo:hello");
  });
});
