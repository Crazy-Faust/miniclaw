import { createConnection, type Socket } from "node:net";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { IOAdapter, MetaCommand } from "@miniclaw/harness";

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
  /**
   * Client-side slash commands the attach loop runs locally instead of
   * sending to the daemon (e.g. /make_skill, which scaffolds files in the
   * shared local workspace). Matched before the built-in socket commands.
   */
  localCommands?: MetaCommand[];
}

/**
 * Connect to the daemon over a Unix socket. In interactive mode every line
 * goes to the daemon and every token/tool/final event comes back from it;
 * the local process owns stdin, stdout, a `/exit` shortcut, the client-side
 * slash commands (/help, /make_skill), and answering confirmation prompts.
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

  // Minimal IOAdapter over the attach loop's readline + stdout, so client-side
  // meta-commands (e.g. /make_skill) can run locally against the shared host.
  const localIO: IOAdapter = {
    async readLine(prompt: string): Promise<string | null> {
      if (!rl) return null;
      try { return await rl.question(prompt); } catch { return null; }
    },
    write: (text: string) => { output.write(text); },
    close: () => { /* the attach loop owns rl */ },
  };

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

  // Both a clean close and a transport error end the loop. markAttached() also
  // unblocks a one-shot still waiting for the attach ack.
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
      case "confirm": {
        // A skill needs approval. Ask the user (interactive) or fail closed
        // (one-shot), then reply. The outer loop is awaiting the turn waiter,
        // so the readline is free to prompt here.
        const id = String(msg.id ?? "");
        const name = String(msg.name ?? "");
        const argShort = truncate(JSON.stringify(msg.args), 120);
        void (async () => {
          let approved = false;
          if (rl) {
            try {
              const ans = (await rl.question(`\n  · confirm ${name}(${argShort})? [y/N] `)).trim().toLowerCase();
              approved = ans === "y" || ans === "yes";
            } catch {
              approved = false;
            }
          }
          try {
            socket.write(JSON.stringify({ type: "confirm_reply", id, approved }) + "\n");
          } catch {
            // Connection may already be gone.
          }
        })();
        return;
      }
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
      case "skills": {
        const tools = (msg.tools ?? []) as Array<{ name: string; description: string }>;
        const sk = (msg.skills ?? []) as Array<{ name: string; description: string; scope?: string }>;
        output.write("Tools:\n");
        for (const s of tools) {
          const first = (s.description ?? "").split("\n")[0] ?? "";
          output.write(`  ${s.name} — ${first}\n`);
        }
        if (sk.length > 0) {
          output.write("\nSkills (SKILL.md, load with use_skill):\n");
          for (const s of sk) {
            const first = (s.description ?? "").split("\n")[0] ?? "";
            const scope = s.scope ? ` [${s.scope}]` : "";
            output.write(`  ${s.name}${scope} — ${first}\n`);
          }
        }
        settleWaiter();
        return;
      }
      case "memories": {
        const rows = (msg.rows ?? []) as Array<{ id: number; kind: string; content: string }>;
        if (rows.length === 0) {
          output.write("  (no memories yet — try \"remember that ...\")\n");
        } else {
          for (const rec of rows) output.write(`  #${rec.id} [${rec.kind}] ${rec.content}\n`);
        }
        settleWaiter();
        return;
      }
      case "reset":
        output.write(`  (reset — new session ${String(msg.sessionId ?? "")})\n`);
        settleWaiter();
        return;
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
  const awaitTurn = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      waiter = { resolve, reject };
    }).catch((err: Error) => {
      output.write(`(${err.message})\n`);
    });

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
      if (trimmed === "/help" || trimmed === "/?") {
        printHelp(opts.localCommands);
        continue;
      }

      // Client-side commands run locally and never touch the socket.
      const local = opts.localCommands?.find((c) => c.matches(trimmed));
      if (local) {
        try {
          await local.run(trimmed, { io: localIO, stop: () => { /* no session loop to stop */ } });
        } catch (err) {
          output.write(`error in ${local.name}: ${(err as Error).message}\n`);
        }
        continue;
      }

      // Server control commands (status/usage/skills/memories/reset/...).
      const ctl = controlMessage(trimmed);
      if (ctl) {
        socket.write(JSON.stringify(ctl) + "\n");
        await awaitTurn();
        continue;
      }

      // Plain user turn.
      socket.write(JSON.stringify({ type: "user", text: trimmed }) + "\n");
      await awaitTurn();
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

// Map an interactive slash command to the server control message it sends, or
// null when it isn't a server command.
function controlMessage(line: string): Record<string, unknown> | null {
  switch (line) {
    case "/status": return { type: "status" };
    case "/usage": return { type: "usage" };
    case "/wiki_maintain": return { type: "wiki_maintain" };
    case "/dream": return { type: "dream" };
    case "/skills": return { type: "skills" };
    case "/reset": return { type: "reset" };
  }
  const mem = line.match(/^\/memories(?:\s+(\d+))?\s*$/);
  if (mem) return { type: "memories", n: mem[1] ? Number(mem[1]) : 10 };
  return null;
}

function printHelp(localCommands?: MetaCommand[]): void {
  const rows: Array<[string, string]> = [
    ["/help", "List these commands (also /?)."],
    ["/status", "Show provider, model, db path, session."],
    ["/usage", "Tool-call counts from the audit log."],
    ["/skills", "List registered tools and SKILL.md skills."],
    ["/memories [N]", "Show recent memories (default 10)."],
    ["/dream", "Run a dreaming/reflection pass."],
    ["/wiki_maintain", "Drain queued memory-to-wiki jobs."],
    ["/reset", "End this session and start a fresh one."],
  ];
  for (const c of localCommands ?? []) rows.push([c.name, c.description]);
  rows.push(["/exit", "Detach from the daemon (also /quit)."]);
  for (const [name, desc] of rows) output.write(`  ${name.padEnd(16)} ${desc}\n`);
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
