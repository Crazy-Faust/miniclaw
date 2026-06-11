import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Agent } from "@miniclaw/agent";
import { CompactingContextManager } from "@miniclaw/context-windowed";
import { createDreamSkill, Dreamer } from "@miniclaw/dreaming";
import {
  CronScheduler,
  defaultPidPath,
  defaultSocketPath,
  Gateway,
  readPid,
  removePid,
  startSocketDaemon,
  writePid,
} from "@miniclaw/gateway";
import { SqliteStore } from "@miniclaw/memory-sqlite";
import {
  createWikiSkills,
  formatMaintenanceResult,
  MemoryWikiMaintainer,
  MemoryWikiWorker,
} from "@miniclaw/memory-wiki";
import { createSessionsSkills } from "@miniclaw/skills-sessions";
import { createCronSkills } from "@miniclaw/skills-cron";
import { createCanvasSkills, CanvasStore } from "@miniclaw/skills-canvas";
import { DiscordTransport } from "@miniclaw/transport-discord";
import type { Transport } from "@miniclaw/core";

import { buildLLM, buildSmallLLM } from "./llm.ts";
import { buildToolGuard, describeSecurityMode } from "./security.ts";
import { buildRegistry } from "./skills.ts";
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
  const llm = buildLLM(config);
  const smallLLM = buildSmallLLM(config);
  const toolGuard = buildToolGuard(config, smallLLM);
  const summarizerLLM = smallLLM ?? llm;
  const registry = buildRegistry();
  const wikiMaintainer = new MemoryWikiMaintainer({
    llm: smallLLM ?? llm,
    queue: store,
    wiki: store,
  });
  const wikiWorker = smallLLM ? new MemoryWikiWorker({ maintainer: wikiMaintainer }) : null;

  // The gateway needs an agent factory — but because the SessionRegistry
  // builds a fresh ContextManager per session, we close over a function
  // that constructs one on demand.
  const gateway = new Gateway({
    sessions: store,
    conversations: store,
    agentFor: (session) => {
      const context = new CompactingContextManager({
        memory: store,
        conversations: store,
        conversationId: session.conversationId,
        summarizer: summarizerLLM,
        knowledge: store,
        workspaceRoot: config.workspaceRoot,
      });
      return new Agent({
        llm,
        registry,
        context,
        memory: store,
        audit: store,
        dbPath: config.dbPath,
        channel: session.channel,
        workspaceRoot: config.workspaceRoot,
        toolGuard,
      });
    },
  });
  for (const sk of createSessionsSkills(gateway)) {
    if (!registry.has(sk.name)) registry.register(sk);
  }
  for (const sk of createCronSkills(store)) {
    if (!registry.has(sk.name)) registry.register(sk);
  }
  const canvasStore = new CanvasStore();
  for (const sk of createCanvasSkills({ store: canvasStore })) {
    if (!registry.has(sk.name)) registry.register(sk);
  }
  for (const sk of createWikiSkills({ wiki: store, maintainer: wikiMaintainer })) {
    if (!registry.has(sk.name)) registry.register(sk);
  }
  const dreamer = new Dreamer({
    llm: summarizerLLM,
    conversations: store,
    memory: store,
    audit: store,
    registry,
    dbPath: config.dbPath,
    workspaceRoot: config.workspaceRoot,
    toolGuard,
  });
  if (!registry.has("dream")) registry.register(createDreamSkill(dreamer));

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
    controls: {
      status: (sessionId, channel, conversationId) => ({
        provider: config.provider,
        model: config.model,
        smallModel: config.smallLLM
          ? `${config.smallLLM.provider}/${config.smallLLM.model}`
          : `(primary ${config.provider}/${config.model})`,
        store: config.dbPath,
        session: sessionId,
        channel,
        conversation: String(conversationId),
        workspace: config.workspaceRoot,
        security: describeSecurityMode(config),
        skills: String(registry.list().length),
      }),
      usage: () => store.auditUsage(),
      wikiMaintain: async () => formatMaintenanceResult(await wikiMaintainer.drain()),
    },
    onShutdown: async () => {
      cron.stop();
      wikiWorker?.stop();
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

  const shutdown = async (): Promise<void> => {
    process.stdout.write("\nminiclaw daemon: shutting down\n");
    await handle.stop();
    process.exit(0);
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
