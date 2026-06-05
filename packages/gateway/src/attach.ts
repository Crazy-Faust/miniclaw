import { createConnection, type Socket } from "node:net";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface SocketAttachOpts {
  socketPath: string;
  channel: string;
  /** Banner printed once before the prompt loop starts. */
  banner?: string;
}

/**
 * Connect to the daemon over a Unix socket and run an interactive REPL
 * where every line goes to the daemon and every token/tool/final event
 * comes back from it. The local process owns only stdin, stdout, and a
 * tiny `/exit` shortcut — the agent itself runs in the daemon.
 *
 * Returns when the user hits EOF, types /exit, or the daemon closes the
 * connection.
 */
export async function socketAttachIO(opts: SocketAttachOpts): Promise<void> {
  const socket = await connect(opts.socketPath);
  socket.setEncoding("utf8");

  const rl = readline.createInterface({ input, output });
  if (opts.banner) output.write(opts.banner.endsWith("\n") ? opts.banner : opts.banner + "\n");

  let buffer = "";
  let waiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  let closedByServer = false;

  socket.write(JSON.stringify({ type: "attach", channel: opts.channel }) + "\n");

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
      } catch {
        continue;
      }
      handleEvent(msg);
    }
  });

  socket.on("close", () => {
    closedByServer = true;
    if (waiter) {
      waiter.reject(new Error("daemon closed the connection"));
      waiter = null;
    }
  });

  function handleEvent(msg: Record<string, unknown>): void {
    const type = String(msg.type ?? "");
    if (type === "attached") {
      output.write(`  · attached to session ${String(msg.sessionId)}\n`);
      return;
    }
    if (type === "token") {
      output.write(String(msg.delta ?? ""));
      return;
    }
    if (type === "tool") {
      const args = JSON.stringify(msg.args);
      output.write(`\n  · tool ${String(msg.name)}(${truncate(args, 120)})\n`);
      return;
    }
    if (type === "tool_result") {
      return;
    }
    if (type === "final") {
      output.write(`\n${String(msg.text ?? "")}\n\n`);
      if (waiter) {
        waiter.resolve();
        waiter = null;
      }
      return;
    }
    if (type === "error") {
      const m = String(msg.message ?? "unknown error");
      output.write(`\nerror: ${m}\n\n`);
      if (waiter) {
        waiter.resolve();
        waiter = null;
      }
      return;
    }
    if (type === "status") {
      const fields = (msg.fields ?? {}) as Record<string, string>;
      for (const [k, v] of Object.entries(fields)) {
        output.write(`  ${k.padEnd(14)} ${v}\n`);
      }
      if (waiter) {
        waiter.resolve();
        waiter = null;
      }
      return;
    }
    if (type === "usage") {
      const rollup = msg.rollup as {
        total: number;
        ok: number;
        failed: number;
        bySkill: Array<{ skill: string; count: number }>;
      } | null;
      if (!rollup) {
        output.write("  (no usage data)\n");
      } else {
        output.write(`  total ${rollup.total} (ok ${rollup.ok}, failed ${rollup.failed})\n`);
        for (const row of rollup.bySkill) {
          output.write(`  ${row.skill.padEnd(20)} ${row.count}\n`);
        }
      }
      if (waiter) {
        waiter.resolve();
        waiter = null;
      }
      return;
    }
  }

  try {
    while (!closedByServer) {
      let line: string;
      try {
        line = await rl.question("> ");
      } catch {
        break;
      }
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed === "/exit" || trimmed === "/quit") break;
      const ctl = trimmed === "/status" ? "status" : trimmed === "/usage" ? "usage" : null;
      if (ctl) {
        socket.write(JSON.stringify({ type: ctl }) + "\n");
        await new Promise<void>((resolve, reject) => {
          waiter = { resolve, reject };
        }).catch((err: Error) => {
          output.write(`(${err.message})\n`);
        });
        continue;
      }
      socket.write(JSON.stringify({ type: "user", text: trimmed }) + "\n");
      await new Promise<void>((resolve, reject) => {
        waiter = { resolve, reject };
      }).catch((err: Error) => {
        output.write(`(${err.message})\n`);
      });
    }
  } finally {
    rl.close();
    try {
      socket.write(JSON.stringify({ type: "end" }) + "\n");
    } catch {
      // Connection may already be gone.
    }
    socket.end();
  }
}

function connect(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = createConnection(socketPath);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
