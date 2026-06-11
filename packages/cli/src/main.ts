// MUST be first — populates process.env from the repo-root .env before
// loadConfig() reads it. Replaces the bare `import "dotenv/config"`,
// which only looks in cwd and so misses the .env when `pnpm dev` runs
// the CLI from packages/cli/.
import "./env.ts";

import { Agent } from "@miniclaw/agent";
import { StatelessContextManager } from "@miniclaw/context-stateless";
import { CompactingContextManager } from "@miniclaw/context-windowed";
import type {
  AuditSink,
  ContextManager,
  ConversationStore,
  MemoryStore,
  SessionStore,
  CronStore,
} from "@miniclaw/core";
import {
  exitCommand,
  Harness,
  type IOAdapter,
  memoriesCommand,
  resetCommand,
  skillsCommand,
  statusCommand,
  usageCommand,
  type SessionControls,
} from "@miniclaw/harness";
import { InMemoryStore } from "@miniclaw/memory-inmemory";
import { SqliteStore } from "@miniclaw/memory-sqlite";
import { createSessionsSkills } from "@miniclaw/skills-sessions";
import { createCronSkills } from "@miniclaw/skills-cron";
import { createCanvasSkills, CanvasStore } from "@miniclaw/skills-canvas";
import { Gateway } from "@miniclaw/gateway";

import { parseArgs, USAGE, type Mode } from "./argv.ts";
import { loadConfig, type Config } from "./config.ts";
import { createOneShotIO, createReadlineIO } from "./io.ts";
import { buildLLM, buildSmallLLM } from "./llm.ts";
import { makeSkillCommand } from "./make-skill/index.ts";
import { buildRegistry } from "./skills.ts";
import { runDaemon } from "./daemon.ts";
import { runChat } from "./chat.ts";
import { runInstall } from "./install.ts";

interface Closeable { close(): void; }

interface AuditUsageRollup {
  total: number;
  ok: number;
  failed: number;
  bySkill: Array<{ skill: string; count: number }>;
}
interface WithUsage { auditUsage(sinceMs?: number): AuditUsageRollup; }

// main() dispatches on the mode produced by argv. Each branch keeps its
// own dependency graph small and explicit; the shared "build agent + run
// REPL" path stays in runRepl/runOneShot.
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  const mode = parsed.mode;

  switch (mode.kind) {
    case "help":
      process.stdout.write(USAGE);
      return;
    case "daemon":
      // status/stop don't need an API key — only the long-running actions
      // touch loadConfig().
      await runDaemon(
        mode.action,
        mode.action === "run" || mode.action === "start" ? loadConfig() : null,
      );
      return;
    case "chat":
      await runChat(mode.channel);
      return;
    case "install":
      runInstall(mode.target, loadConfig());
      return;
    case "repl":
    case "one-shot":
      await runAgent(mode, loadConfig());
      return;
  }
}

async function runAgent(mode: Extract<Mode, { kind: "repl" | "one-shot" }>, config: Config): Promise<void> {
  const oneShot = mode.kind === "one-shot";
  const ephemeral = mode.ephemeral;
  const stateless = mode.stateless;

  const store: MemoryStore & ConversationStore & AuditSink & SessionStore & CronStore & WithUsage & Closeable =
    ephemeral ? new InMemoryStore() : new SqliteStore(config.dbPath);

  const convId = store.newConversation();
  const registry = buildRegistry();
  const llm = buildLLM(config);
  const smallLLM = buildSmallLLM(config);
  const summarizerLLM = smallLLM ?? llm;

  const context: ContextManager = stateless
    ? new StatelessContextManager()
    : new CompactingContextManager({
        memory: store,
        conversations: store,
        conversationId: convId,
        summarizer: summarizerLLM,
        workspaceRoot: config.workspaceRoot,
      });

  const oneShotIO = oneShot;
  const io: IOAdapter = oneShotIO
    ? createOneShotIO(mode.kind === "one-shot" ? mode.prompt : "")
    : createReadlineIO();

  const agent = new Agent({
    llm,
    registry,
    context,
    memory: store,
    audit: store,
    dbPath: ephemeral ? ":memory:" : config.dbPath,
    channel: "cli",
    workspaceRoot: config.workspaceRoot,
    confirmTool: io.confirm
      ? async (call, skill) => {
          const argStr = JSON.stringify(call.args);
          const argShort = argStr.length > 120 ? argStr.slice(0, 119) + "…" : argStr;
          return io.confirm!(`approve ${skill.name}(${argShort})? [y/N] `);
        }
      : undefined,
  });

  // Wire the gateway so sessions_* skills can see the current channel
  // alongside any cron-spawned sessions. The REPL itself runs on the
  // "cli" channel.
  const gateway = new Gateway({
    sessions: store,
    conversations: store,
    agentFor: () => agent,
  });
  gateway.attach("cli");
  for (const sk of createSessionsSkills(gateway)) {
    registry.register(sk);
  }
  for (const sk of createCronSkills(store)) {
    registry.register(sk);
  }
  const canvasStore = new CanvasStore();
  for (const sk of createCanvasSkills({ store: canvasStore })) {
    registry.register(sk);
  }

  const controls: SessionControls = {
    status: () => ({
      provider: config.provider,
      model: config.model,
      smallModel: config.smallLLM
        ? `${config.smallLLM.provider}/${config.smallLLM.model}`
        : `(primary ${config.provider}/${config.model})`,
      store: ephemeral ? "(ephemeral)" : config.dbPath,
      conversation: String(convId),
      workspace: config.workspaceRoot,
      skills: String(registry.list().length),
    }),
    usage: () => store.auditUsage(),
  };

  const banner = oneShotIO
    ? undefined
    : (
        `miniclaw — provider ${config.provider}, model ${config.model}, ` +
        `small ${config.smallLLM ? `${config.smallLLM.provider}/${config.smallLLM.model}` : "primary"}, ` +
        `${ephemeral ? "ephemeral store" : `db ${config.dbPath}`}, ` +
        `${stateless ? "stateless context" : "windowed context"}\n` +
        `skills: ${registry.list().map((s) => s.name).join(", ")}\n` +
        `type /help for slash commands, /exit to quit\n`
      );

  const metaCommands = oneShotIO
    ? []
    : [
        exitCommand(),
        skillsCommand(registry),
        memoriesCommand(store),
        statusCommand(controls),
        resetCommand(controls),
        usageCommand(controls),
        makeSkillCommand(),
      ];

  const harness = new Harness({ agent, io, banner, metaCommands });

  try {
    await harness.run();
  } finally {
    store.close();
  }
}
