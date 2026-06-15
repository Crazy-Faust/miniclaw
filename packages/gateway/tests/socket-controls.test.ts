import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Agent } from "@miniclaw/agent";
import { Gateway } from "../src/gateway.ts";
import { startSocketDaemon, type SocketDaemonControls, type SocketDaemonHandle } from "../src/daemon.ts";

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

// Connect, send the outbound messages in order, collect replies, resolve the
// full list once `stop` matches a reply.
function exchange(
  socketPath: string,
  outbound: Record<string, unknown>[],
  stop: (msg: any) => boolean,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    sock.setEncoding("utf8");
    sock.once("error", reject);
    const received: any[] = [];
    let buf = "";
    sock.on("data", (chunk: string | Buffer) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        received.push(msg);
        if (stop(msg)) { sock.end(); resolve(received); }
      }
    });
    sock.once("connect", () => {
      for (const m of outbound) sock.write(JSON.stringify(m) + "\n");
    });
  });
}

const simpleAgent = () =>
  ({ async runTurn() { return { toolCalls: [], finalText: "ok" }; } } as unknown as Agent);

describe("socket controls — skills / memories / reset (Step 2.2)", () => {
  let dir: string;
  let socketPath: string;
  let handle: SocketDaemonHandle;

  const controls: SocketDaemonControls = {
    status: () => ({}),
    usage: () => ({ total: 0, ok: 0, failed: 0, bySkill: [] }),
    skills: () => ({
      tools: [{ name: "shell", description: "run a shell command\nsecond line" }],
      skills: [{ name: "pdf", description: "make pdfs", scope: "bundled" }],
    }),
    memories: (n) => ({ rows: [{ id: 1, kind: "note", content: "hello" }].slice(0, n) }),
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-ctl-"));
    socketPath = join(dir, "test.sock");
    const store = makeStore();
    const gw = new Gateway({ sessions: store, conversations: store, agentFor: simpleAgent });
    handle = startSocketDaemon({ gateway: gw, socketPath, controls });
    await new Promise((r) => handle.server.once("listening", r));
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers /skills with tools + SKILL.md skills", async () => {
    const msgs = await exchange(
      socketPath,
      [{ type: "attach", channel: "cli" }, { type: "skills" }],
      (m) => m.type === "skills",
    );
    const reply = msgs.find((m) => m.type === "skills");
    expect(reply.tools).toEqual([{ name: "shell", description: "run a shell command\nsecond line" }]);
    expect(reply.skills).toEqual([{ name: "pdf", description: "make pdfs", scope: "bundled" }]);
  });

  it("answers /memories with recent rows, honoring N", async () => {
    const msgs = await exchange(
      socketPath,
      [{ type: "attach", channel: "cli" }, { type: "memories", n: 5 }],
      (m) => m.type === "memories",
    );
    const reply = msgs.find((m) => m.type === "memories");
    expect(reply.rows).toEqual([{ id: 1, kind: "note", content: "hello" }]);
  });

  it("reset ends the session and replies with a fresh session id", async () => {
    const msgs = await exchange(
      socketPath,
      [{ type: "attach", channel: "cli" }, { type: "reset" }],
      (m) => m.type === "reset",
    );
    const attached = msgs.find((m) => m.type === "attached");
    const reset = msgs.find((m) => m.type === "reset");
    expect(reset.sessionId).not.toBe(attached.sessionId);
  });
});

describe("socket confirm round-trip (Step 2.3)", () => {
  let dir: string;
  let socketPath: string;
  let handle: SocketDaemonHandle;

  // A fake agent whose turn delegates to the per-turn onConfirmTool hook, so
  // the test exercises the server's confirm/confirm_reply bridging end-to-end.
  const confirmingAgent = () =>
    ({
      async runTurn(_msg: string, hooks?: { onConfirmTool?: (c: any, s: any) => Promise<boolean> }) {
        const approved = hooks?.onConfirmTool
          ? await hooks.onConfirmTool({ name: "danger", args: { z: 1 } }, { name: "danger", description: "dangerous" })
          : false;
        return {
          toolCalls: [{ name: "danger", args: { z: 1 }, ok: approved, output: approved ? "ran" : "declined" }],
          finalText: approved ? "did the dangerous thing" : "denied",
        };
      },
    } as unknown as Agent);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-confirm-sock-"));
    socketPath = join(dir, "test.sock");
    const store = makeStore();
    const gw = new Gateway({ sessions: store, conversations: store, agentFor: confirmingAgent });
    handle = startSocketDaemon({ gateway: gw, socketPath });
    await new Promise((r) => handle.server.once("listening", r));
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  // Run one turn, auto-answering the confirm prompt with `approve`.
  function runTurn(approve: boolean): Promise<{ confirm: any; finalText: string }> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(socketPath);
      sock.setEncoding("utf8");
      sock.once("error", reject);
      let confirm: any = null;
      let buf = "";
      sock.on("data", (chunk: string | Buffer) => {
        buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.type === "attached") {
            sock.write(JSON.stringify({ type: "user", text: "go" }) + "\n");
          } else if (msg.type === "confirm") {
            confirm = msg;
            sock.write(JSON.stringify({ type: "confirm_reply", id: msg.id, approved: approve }) + "\n");
          } else if (msg.type === "final") {
            sock.end();
            resolve({ confirm, finalText: String(msg.text) });
          } else if (msg.type === "error") {
            sock.end();
            reject(new Error(String(msg.message)));
          }
        }
      });
      sock.once("connect", () => sock.write(JSON.stringify({ type: "attach", channel: "cli" }) + "\n"));
    });
  }

  it("emits a confirm event and denies the tool on confirm_reply:false", async () => {
    const { confirm, finalText } = await runTurn(false);
    expect(confirm).toMatchObject({ name: "danger", description: "dangerous" });
    expect(typeof confirm.id).toBe("string");
    expect(finalText).toBe("denied");
  });

  it("runs the tool on confirm_reply:true", async () => {
    const { confirm, finalText } = await runTurn(true);
    expect(confirm).toMatchObject({ name: "danger" });
    expect(finalText).toBe("did the dangerous thing");
  });
});
