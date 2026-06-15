// MUST be first — populates process.env from the repo-root .env before
// loadConfig() reads it. Replaces the bare `import "dotenv/config"`,
// which only looks in cwd and so misses the .env when `pnpm dev` runs
// the CLI from packages/cli/.
import "./env.ts";

import {
  exitCommand,
  Harness,
  type IOAdapter,
  memoriesCommand,
  dreamCommand,
  resetCommand,
  skillsCommand,
  statusCommand,
  usageCommand,
  wikiMaintainCommand,
  type SessionControls,
} from "@miniclaw/harness";
import { InMemoryStore } from "@miniclaw/memory-inmemory";
import { SqliteStore } from "@miniclaw/memory-sqlite";

import { parseArgs, USAGE, type Mode } from "./argv.ts";
import { buildAgentStack } from "./agent-stack.ts";
import { loadConfig, type Config } from "./config.ts";
import { createOneShotIO, createReadlineIO } from "./io.ts";
import { makeSkillCommand } from "./make-skill/index.ts";
import { runDaemon } from "./daemon.ts";
import { runClient } from "./chat.ts";
import { runInstall } from "./install.ts";

// main() dispatches on the mode produced by argv. Normal launches attach to
// an (auto-started) daemon via runClient; --ephemeral/--stateless drop into
// the in-process bypass (runAgent), which shares buildAgentStack with the
// daemon.
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
      await runClient({ channel: mode.channel, fresh: false });
      return;
    case "install":
      runInstall(mode.target, loadConfig());
      return;
    case "repl":
      // --ephemeral / --stateless are the only in-process bypass (D2);
      // every other launch attaches to an (auto-started) daemon. repl
      // defaults to a fresh session per launch unless --resume is given.
      if (mode.stateless || mode.ephemeral) {
        await runAgent(mode, loadConfig());
        return;
      }
      await runClient({ channel: mode.channel ?? "cli", fresh: !mode.resume });
      return;
    case "one-shot":
      if (mode.stateless || mode.ephemeral) {
        await runAgent(mode, loadConfig());
        return;
      }
      await runClient({ channel: mode.channel ?? "cli", fresh: !mode.resume, oneShot: mode.prompt });
      return;
  }
}

// The in-process bypass: a deliberately reduced "throwaway" agent with no
// daemon, cron, or transports. It shares the whole agent/skill/gateway stack
// with the daemon via buildAgentStack and only adds the local readline
// Harness (all nine slash commands) on top.
async function runAgent(mode: Extract<Mode, { kind: "repl" | "one-shot" }>, config: Config): Promise<void> {
  const oneShot = mode.kind === "one-shot";
  const store = mode.ephemeral ? new InMemoryStore() : new SqliteStore(config.dbPath);

  const io: IOAdapter = oneShot
    ? createOneShotIO(mode.kind === "one-shot" ? mode.prompt : "")
    : createReadlineIO();

  // In-process confirmation is answered through the readline IO. (Over the
  // socket it is a per-turn hook instead — see the daemon path.)
  const confirmTool = io.confirm
    ? async (
        call: { name: string; args: unknown },
        skill: { name: string; description: string },
      ): Promise<boolean> => {
        const argStr = JSON.stringify(call.args);
        const argShort = argStr.length > 120 ? argStr.slice(0, 119) + "…" : argStr;
        return io.confirm!(`approve ${skill.name}(${argShort})? [y/N] `);
      }
    : undefined;

  const stack = await buildAgentStack(config, store, {
    oneShot,
    stateless: mode.stateless,
    confirmTool,
  });
  const { gateway, registry, controls: socket, agentFor, wikiWorker, wikiBrowser, agentSkillList } = stack;

  // The bypass talks to a single "cli" session: build its agent once and
  // adapt the socket-shaped controls to the harness SessionControls.
  const cli = gateway.attach("cli");
  const agent = agentFor(cli.record);
  const controls: SessionControls = {
    status: () => socket.status(cli.record.id, "cli", cli.record.conversationId),
    dream: () => socket.dream!(),
    wikiMaintain: () => socket.wikiMaintain!(),
    usage: () => socket.usage(),
  };

  const banner = oneShot
    ? undefined
    : (
        `(in-process mode — no daemon, cron/transports unavailable)\n` +
        `${mode.stateless ? "stateless context" : "compacting context"}\n` +
        (wikiBrowser ? `wiki browser: ${wikiBrowser.url}\n` : "") +
        `type /help for slash commands, /exit to quit\n`
      );

  const metaCommands = oneShot
    ? []
    : [
        exitCommand(),
        skillsCommand(registry, agentSkillList),
        memoriesCommand(store),
        dreamCommand(controls),
        wikiMaintainCommand(controls),
        statusCommand(controls),
        resetCommand(controls),
        usageCommand(controls),
        makeSkillCommand(),
      ];

  const harness = new Harness({ agent, io, banner, metaCommands });

  try {
    wikiWorker?.start();
    await harness.run();
  } finally {
    await stack.close();
    store.close();
  }
}
