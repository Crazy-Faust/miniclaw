import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CronScheduler,
  defaultPidPath,
  defaultSocketPath,
  readPid,
  removePid,
  startSocketDaemon,
  writePid,
} from "@miniclaw/gateway";
import { SqliteStore } from "@miniclaw/memory-sqlite";
import { DiscordTransport } from "@miniclaw/transport-discord";
import type { Transport } from "@miniclaw/core";

import { buildAgentStack } from "./agent-stack.ts";
import type { Config } from "./config.ts";

// Spawn the daemon child by re-entering the CLI's main entry point so its
// argv dispatch in main.ts routes to `daemon run`. Pointing at daemon.ts
// directly would just import this module and exit — no top-level handler.
const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");

export async function runDaemon(
  action: "run" | "start" | "stop" | "status",
  config: Config | null,
): Promise<void> {
  const socketPath = defaultSocketPath();
  const pidPath = defaultPidPath();

  if (action === "status") {
    const pid = readPid(pidPath);
    if (pid && isAlive(pid)) {
      process.stdout.write(`miniclaw daemon: running (pid ${pid}, socket ${socketPath})\n`);
    } else {
      process.stdout.write("miniclaw daemon: not running\n");
    }
    return;
  }

  if (action === "stop") {
    const pid = readPid(pidPath);
    if (!pid || !isAlive(pid)) {
      process.stdout.write("miniclaw daemon: not running\n");
      removePid(pidPath);
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
      process.stdout.write(`sent SIGTERM to pid ${pid}\n`);
    } catch (err) {
      process.stderr.write(`failed to stop pid ${pid}: ${(err as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (action === "start") {
    const pid = readPid(pidPath);
    if (pid && isAlive(pid)) {
      process.stdout.write(`miniclaw daemon already running (pid ${pid})\n`);
      return;
    }
    if (existsSync(socketPath)) {
      // Stale socket from a crashed previous run.
      // The socket-daemon code removes its socket on startup too, but
      // we surface the cleanup here so the user knows.
      process.stdout.write(`removing stale socket ${socketPath}\n`);
    }
    const child = spawn(process.execPath, [...process.execArgv, ENTRY, "daemon", "run"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    process.stdout.write(`miniclaw daemon: started in background (pid ${child.pid})\n`);
    return;
  }

  // action === "run" — block and serve.
  if (!config) throw new Error("daemon run requires a loaded config");
  await runForeground(config, socketPath, pidPath);
}

async function runForeground(config: Config, socketPath: string, pidPath: string): Promise<void> {
  writePid(pidPath, process.pid);

  const store = new SqliteStore(config.dbPath);
  // Everything agent-side (LLMs, skills, gateway, wiki worker/browser, dreamer,
  // controls) comes from the shared builder; the daemon only adds transports,
  // the cron scheduler, the socket server, and signal handling.
  const stack = await buildAgentStack(config, store, { oneShot: false });
  const { gateway, wikiWorker, wikiBrowser } = stack;

  const transports: Transport[] = [];
  const discordToken = process.env.MINICLAW_DISCORD_TOKEN;
  if (discordToken) {
    const discord = new DiscordTransport({
      gateway,
      allowlist: store,
      pairings: store,
      token: discordToken,
    });
    try {
      await discord.start();
      transports.push(discord);
      process.stdout.write("miniclaw daemon: discord transport connected\n");
    } catch (err) {
      process.stderr.write(`miniclaw daemon: discord transport failed: ${(err as Error).message}\n`);
    }
  }

  const cron = new CronScheduler({
    store,
    gateway,
    onResult: async (_job, channel, text) => {
      if (!text) return;
      for (const t of transports) {
        const maybeSender = t as Transport & {
          sendToChannel?: (channel: string, text: string) => Promise<boolean> | boolean;
        };
        if (maybeSender.sendToChannel && await maybeSender.sendToChannel(channel, text)) {
          return;
        }
      }
    },
  });
  cron.start();
  wikiWorker?.start();

  const handle = startSocketDaemon({
    gateway,
    socketPath,
    controls: stack.controls,
    onShutdown: async () => {
      cron.stop();
      await stack.close();
      for (const t of transports) {
        try { await t.stop(); } catch { /* shutdown is best-effort */ }
      }
      store.close();
      removePid(pidPath);
    },
  });

  process.stdout.write(
    `miniclaw daemon: listening on ${socketPath} (pid ${process.pid}, db ${config.dbPath})\n`,
  );
  if (wikiBrowser) {
    process.stdout.write(`miniclaw wiki browser: ${wikiBrowser.url}\n`);
  }

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    process.exitCode = 0;
    shutdownPromise = (async () => {
      process.stdout.write("\nminiclaw daemon: shutting down\n");
      await handle.stop();
      process.exit(0);
    })();
    return shutdownPromise;
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  // Block forever; the socket server keeps the event loop alive.
  await new Promise<void>(() => undefined);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
