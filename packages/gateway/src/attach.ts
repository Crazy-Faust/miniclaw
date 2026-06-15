import { createConnection, type Socket } from "node:net";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface SocketAttachOpts {
  socketPath: string;
  channel: string;
  /** Banner printed once before the prompt loop starts. */
  banner?: string;
  /**
   * Spawn a brand-new session for the channel instead of resuming its
   * active one. Maps to the daemon's gateway.spawn() vs gateway.attach().
   */
  fresh?: boolean;
  /**
   * Non-interactive one-shot: send this text as a single turn, print the
   * final answer, then detach — no readline loop is started and the daemon
   * keeps running. Used by `miniclaw "prompt"`.
   */
  oneShot?: string;
}

/**
 * Connect to the daemon over a Unix socket. In interactive mode every line
 * goes to the daemon and every token/tool/final event comes back from it;
 * the local process owns only stdin, stdout, and a tiny `/exit` shortcut.
 *
 * In one-shot mode (opts.oneShot set) there is no prompt loop: the client
 * sends a single turn, prints the final answer once, and detaches.
 *
 * Returns when the user hits EOF, types /exit, the one-shot turn finishes,
 * or the daemon closes the connection.
 */
export async function socketAttachIO(opts: SocketAttachOpts): Promise<void> {
  const interactive = opts.oneShot === undefined;
  const socket = await connect(opts.socketPath);
  socket.setEncoding("utf8");

  const rl = interactive ? readline.createInterface({ input, output }) : null;
  if (opts.banner) output.write(opts.banner.endsWith("\n") ? opts.banner : opts.banner + "\n");

  let buffer = "";
  let waiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  let resolveAttached: (() => void) | null = null;
  const attached = new Promise<void>((r) => { resolveAttached = r; });
  let closedByServer = false;

  const settleWaiter = (): void => { if (waiter) { waiter.resolve(); waiter = null; } };
  const markAttached = (): void => { if (resolveAttached) { resolveAttached(); resolveAttached = null; } };

  socket.write(JSON.stringify({ type: "attach", channel: opts.channel, fresh: opts.fresh ?? false }) + "\n");

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

  // Both a clean close and a transport error end the loop. The previous
  // client had no "error" handler, so a mid-turn ECONNRESET would crash the
  // process; treat it like a close. markAttached() also unblocks a one-shot
  // that is still waiting for the attach ack.
  const endLoop = (err: Error): void => {
    closedByServer = true;
    markAttached();
    if (waiter) {
      waiter.reject(err);
      waiter = null;
    }
  };
  socket.on("close", () => endLoop(new Error("daemon closed the connection")));
  socket.on("error", (err: Error) => endLoop(err));

  function handleEvent(msg: Record<string, unknown>): void {
    const type = String(msg.type ?? "");
    switch (type) {
      case "attached":
        if (interactive) output.write(`  · attached to session ${String(msg.sessionId)}\n`);
        markAttached();
        return;
      case "token":
        // One-shot prints the final answer once (matching the old in-process
        // one-shot); it does not echo streamed partial tokens.
        if (interactive) output.write(String(msg.delta ?? ""));
        return;
      case "tool": {
        const args = JSON.stringify(msg.args);
        output.write(`\n  · tool ${String(msg.name)}(${truncate(args, 120)})\n`);
        return;
      }
      case "tool_result":
        return;
      case "final":
        output.write(interactive ? `\n${String(msg.text ?? "")}\n\n` : `${String(msg.text ?? "")}\n`);
        settleWaiter();
        return;
      case "error":
        output.write(`\nerror: ${String(msg.message ?? "unknown error")}\n\n`);
        settleWaiter();
        return;
      case "status": {
        const fields = (msg.fields ?? {}) as Record<string, string>;
        for (const [k, v] of Object.entries(fields)) output.write(`  ${k.padEnd(14)} ${v}\n`);
        settleWaiter();
        return;
      }
      case "usage": {
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
        settleWaiter();
        return;
      }
      case "wiki_maintain":
      case "dream":
        output.write(`${String(msg.text ?? "")}\n`);
        settleWaiter();
        return;
    }
  }

  // One-shot: send a single turn, print the final answer, detach. The daemon
  // keeps running.
  if (!interactive) {
    try {
      await attached;
      if (!closedByServer) {
        socket.write(JSON.stringify({ type: "user", text: opts.oneShot }) + "\n");
        await new Promise<void>((resolve, reject) => {
          waiter = { resolve, reject };
        }).catch((err: Error) => {
          output.write(`(${err.message})\n`);
        });
      }
    } finally {
      try {
        socket.write(JSON.stringify({ type: "end" }) + "\n");
      } catch {
        // Connection may already be gone.
      }
      socket.end();
    }
    return;
  }

  // Interactive REPL loop.
  try {
    while (!closedByServer) {
      let line: string;
      try {
        line = await rl!.question("> ");
      } catch {
        break;
      }
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed === "/exit" || trimmed === "/quit") break;
      const ctl =
        trimmed === "/status" ? "status" :
        trimmed === "/usage" ? "usage" :
        trimmed === "/wiki_maintain" ? "wiki_maintain" :
        trimmed === "/dream" ? "dream" :
        null;
      const payload = ctl ? { type: ctl } : { type: "user", text: trimmed };
      socket.write(JSON.stringify(payload) + "\n");
      await new Promise<void>((resolve, reject) => {
        waiter = { resolve, reject };
      }).catch((err: Error) => {
        output.write(`(${err.message})\n`);
      });
    }
  } finally {
    rl!.close();
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
