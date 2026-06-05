import { createServer, type Server, type Socket } from "node:net";
import { existsSync, rmSync } from "node:fs";
import type { Gateway } from "./gateway.ts";

export interface SocketDaemonOpts {
  gateway: Gateway;
  /** Path to the Unix domain socket. */
  socketPath: string;
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
 *   { type: "user",  text: "..." }      → run one agent turn
 *   { type: "end" }                     → end the session and disconnect
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
  const server = createServer((socket) => handleClient(socket, opts.gateway));
  server.listen(opts.socketPath);

  const stop = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(opts.socketPath)) rmSync(opts.socketPath, { force: true });
    await opts.onShutdown?.();
  };

  return { server, stop };
}

function handleClient(socket: Socket, gateway: Gateway): void {
  let buffer = "";
  let session: ReturnType<Gateway["attach"]> | null = null;

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
      const channel = String(msg.channel ?? "");
      if (!channel) {
        send({ type: "error", message: "attach requires 'channel'" });
        return;
      }
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
    if (type === "end") {
      if (session) gateway.end(session.record.id);
      socket.end();
      return;
    }
    send({ type: "error", message: `unknown message type: ${type}` });
  }
}
