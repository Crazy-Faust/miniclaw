import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Gateway } from "./gateway.ts";

export interface SocketDaemonControls {
  /** Per-attached-session status fields (label -> value). */
  status(sessionId: string, channel: string, conversationId: number): Record<string, string>;
  /** Aggregate tool-call usage from the audit log. */
  usage(): {
    total: number;
    ok: number;
    failed: number;
    bySkill: Array<{ skill: string; count: number }>;
  };
  /** Drain memory-to-wiki maintenance jobs. */
  wikiMaintain?(): Promise<string> | string;
  /** Run a manual dream pass. */
  dream?(): Promise<string> | string;
}

export interface SocketDaemonOpts {
  gateway: Gateway;
  /** Path to the Unix domain socket. */
  socketPath: string;
  /** Lets attached clients answer their own /status and /usage commands. */
  controls?: SocketDaemonControls;
  /** Optional shutdown hook called after the server stops. */
  onShutdown?: () => void | Promise<void>;
}

export interface SocketDaemonHandle {
  server: Server;
  stop(): Promise<void>;
}

/**
 * Open a Unix-domain socket. Each client speaks JSON-Lines. The very
 * first message must be { "type": "attach", "channel": "..." }. After
 * that the server accepts:
 *
 *   { type: "user",  text: "..." }      -> run one agent turn
 *   { type: "end" }                     -> end the session and disconnect
 *
 * The server emits, for each turn:
 *
 *   { type: "token", delta }            (streaming providers)
 *   { type: "tool",  name, args }
 *   { type: "tool_result", name, ok, output }
 *   { type: "final", text }
 *   { type: "error", message }
 */
export function startSocketDaemon(opts: SocketDaemonOpts): SocketDaemonHandle {
  if (existsSync(opts.socketPath)) {
    rmSync(opts.socketPath, { force: true });
  }

  // VULN-13: Ensure the enclosing directory has restrictive permissions
  // (0700) so other users on shared machines cannot connect.
  const socketDir = dirname(opts.socketPath);
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  try { chmodSync(socketDir, 0o700); } catch { /* best-effort on existing dirs */ }

  const server = createServer((socket) => handleClient(socket, opts.gateway, opts.controls));
  server.listen(opts.socketPath, () => {
    // VULN-13: Set socket file permissions to owner-only after binding.
    try { chmodSync(opts.socketPath, 0o600); } catch { /* best-effort */ }
  });

  const stop = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(opts.socketPath)) rmSync(opts.socketPath, { force: true });
    await opts.onShutdown?.();
  };

  return { server, stop };
}

function handleClient(socket: Socket, gateway: Gateway, controls?: SocketDaemonControls): void {
  let buffer = "";
  let session: ReturnType<Gateway["attach"]> | null = null;
  let channel = "";

  const send = (event: Record<string, unknown>): void => {
    if (socket.writable) socket.write(JSON.stringify(event) + "\n");
  };

  socket.setEncoding("utf8");
  socket.on("data", (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim().length === 0) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch (err) {
        send({ type: "error", message: `invalid json: ${(err as Error).message}` });
        continue;
      }
      void dispatch(msg);
    }
  });

  socket.on("error", () => { /* client disconnected */ });

  async function dispatch(msg: Record<string, unknown>): Promise<void> {
    const type = String(msg.type ?? "");
    if (type === "attach") {
      const ch = String(msg.channel ?? "");
      if (!ch) {
        send({ type: "error", message: "attach requires 'channel'" });
        return;
      }
      channel = ch;
      session = gateway.attach(channel);
      send({ type: "attached", sessionId: session.record.id, channel });
      return;
    }
    if (!session) {
      send({ type: "error", message: "must attach before sending" });
      return;
    }
    if (type === "user") {
      const text = String(msg.text ?? "");
      if (!text) {
        send({ type: "error", message: "user requires non-empty 'text'" });
        return;
      }
      try {
        const trace = await session.send(text, {
          onAssistantToken: (delta) => send({ type: "token", delta }),
          onIntermediateText: (text) => send({ type: "token", delta: text }),
          onTool: (name, args) => send({ type: "tool", name, args }),
          onPostToolUse: (call, result) =>
            send({ type: "tool_result", name: call.name, ok: result.ok, output: result.output }),
        });
        send({ type: "final", text: trace.finalText });
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      }
      return;
    }
    if (type === "status") {
      const fields = controls
        ? controls.status(session.record.id, channel, session.record.conversationId)
        : { session: session.record.id, channel, conversation: String(session.record.conversationId) };
      send({ type: "status", fields });
      return;
    }
    if (type === "usage") {
      const rollup = controls?.usage() ?? { total: 0, ok: 0, failed: 0, bySkill: [] };
      send({ type: "usage", rollup });
      return;
    }
    if (type === "wiki_maintain") {
      if (!controls?.wikiMaintain) {
        send({ type: "error", message: "wiki maintenance is not configured" });
        return;
      }
      try {
        const text = await controls.wikiMaintain();
        send({ type: "wiki_maintain", text });
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      }
      return;
    }
    if (type === "dream") {
      if (!controls?.dream) {
        send({ type: "error", message: "dreaming is not configured" });
        return;
      }
      try {
        const text = await controls.dream();
        send({ type: "dream", text });
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      }
      return;
    }
    if (type === "end") {
      if (session) gateway.end(session.record.id);
      socket.end();
      return;
    }
    send({ type: "error", message: `unknown message type: ${type}` });
  }
}
