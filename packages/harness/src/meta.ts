import type { MemoryStore, SkillRegistry } from "@miniclaw/core";
import type { IOAdapter } from "./io.ts";
import type { SessionControls } from "./session-controls.ts";

// Meta-commands are slash-prefixed local actions the harness handles itself
// (without ever calling the LLM). Each command owns its own matching and
// execution; the harness just iterates the list and dispatches.

export interface MetaCommandContext {
  io: IOAdapter;
  /** Set this to true from inside run() to stop the session loop. */
  stop(): void;
}

export interface MetaCommand {
  /** Short label shown by /help (e.g. "/exit"). */
  name: string;
  /** One-line description shown by /help. */
  description: string;
  /** Return true if this command should handle the given input line. */
  matches(line: string): boolean;
  /**
   * Execute the command. May call ctx.stop() to terminate the loop.
   * Returns either void (sync) or Promise<void> (for multi-step wizards
   * that need to await ctx.io.readLine() between prompts).
   */
  run(line: string, ctx: MetaCommandContext): void | Promise<void>;
}

// ---- Built-in command factories ----

export function exitCommand(): MetaCommand {
  return {
    name: "/exit",
    description: "Quit the session (also: /quit).",
    matches: (line) => line === "/exit" || line === "/quit",
    run: (_line, ctx) => ctx.stop(),
  };
}

export function helpCommand(getAll: () => MetaCommand[]): MetaCommand {
  return {
    name: "/help",
    description: "List available slash commands.",
    matches: (line) => line === "/help" || line === "/?",
    run: (_line, ctx) => {
      for (const c of getAll()) {
        ctx.io.write(`  ${c.name.padEnd(14)} ${c.description}\n`);
      }
    },
  };
}

export function skillsCommand(registry: SkillRegistry): MetaCommand {
  return {
    name: "/skills",
    description: "List registered skills.",
    matches: (line) => line === "/skills",
    run: (_line, ctx) => {
      for (const s of registry.list()) {
        const first = s.description.split("\n")[0] ?? "";
        ctx.io.write(`  ${s.name} — ${first}\n`);
      }
    },
  };
}

export function clearCommand(controls: SessionControls): MetaCommand {
  return {
    name: "/clear",
    description: "Start a fresh conversation (discards in-context history).",
    matches: (line) => line === "/clear",
    async run(_line, ctx) {
      if (!controls.clear) {
        ctx.io.write("  (this session doesn't support /clear)\n");
        return;
      }
      await controls.clear();
      ctx.io.write("  (cleared — started a new conversation)\n");
    },
  };
}

export function compactCommand(controls: SessionControls): MetaCommand {
  return {
    name: "/compact",
    description: "Summarize older turns to free up context budget.",
    matches: (line) => line === "/compact",
    async run(_line, ctx) {
      if (!controls.compact) {
        ctx.io.write("  (this session doesn't support /compact)\n");
        return;
      }
      try {
        await controls.compact();
        ctx.io.write("  (compacted)\n");
      } catch (err) {
        ctx.io.write(`  compaction failed: ${(err as Error).message}\n`);
      }
    },
  };
}

export function dreamCommand(controls: SessionControls): MetaCommand {
  return {
    name: "/dream",
    description: "Review recent conversations and extract useful memories/tasks.",
    matches: (line) => line === "/dream",
    async run(_line, ctx) {
      if (!controls.dream) {
        ctx.io.write("  (this session doesn't support /dream)\n");
        return;
      }
      try {
        const result = await controls.dream();
        ctx.io.write(indentBlock(result) + "\n");
      } catch (err) {
        ctx.io.write(`  dream failed: ${(err as Error).message}\n`);
      }
    },
  };
}

export function wikiMaintainCommand(controls: SessionControls): MetaCommand {
  return {
    name: "/wiki_maintain",
    description: "Drain queued memory-to-wiki maintenance jobs.",
    matches: (line) => line === "/wiki_maintain",
    async run(_line, ctx) {
      if (!controls.wikiMaintain) {
        ctx.io.write("  (this session doesn't support /wiki_maintain)\n");
        return;
      }
      try {
        const result = await controls.wikiMaintain();
        ctx.io.write(indentBlock(result) + "\n");
      } catch (err) {
        ctx.io.write(`  wiki maintenance failed: ${(err as Error).message}\n`);
      }
    },
  };
}

export function modelCommand(controls: SessionControls): MetaCommand {
  return {
    name: "/model",
    description: "Show the current model, or switch with /model <name>.",
    matches: (line) => /^\/model(\s+\S+)?\s*$/.test(line),
    async run(line, ctx) {
      const m = line.match(/^\/model(?:\s+(\S+))?\s*$/);
      const requested = m && m[1] ? m[1] : null;
      if (!requested) {
        const current = controls.getModel ? controls.getModel() : "(unknown)";
        ctx.io.write(`  current: ${current}\n`);
        if (controls.listAvailableModels) {
          const avail = controls.listAvailableModels();
          if (avail.length > 0) {
            ctx.io.write(`  available: ${avail.join(", ")}\n`);
          }
        }
        return;
      }
      if (!controls.setModel) {
        ctx.io.write("  (this session doesn't support model switching)\n");
        return;
      }
      try {
        await controls.setModel(requested);
        ctx.io.write(`  model -> ${requested}\n`);
      } catch (err) {
        ctx.io.write(`  could not switch model: ${(err as Error).message}\n`);
      }
    },
  };
}

export function resumeCommand(controls: SessionControls): MetaCommand {
  return {
    name: "/resume",
    description: "List prior conversations, or resume one with /resume <id>.",
    matches: (line) => /^\/resume(\s+\d+)?\s*$/.test(line),
    async run(line, ctx) {
      const m = line.match(/^\/resume(?:\s+(\d+))?\s*$/);
      const requested = m && m[1] ? Number(m[1]) : null;
      if (!requested) {
        if (!controls.listConversations) {
          ctx.io.write("  (this session doesn't support /resume)\n");
          return;
        }
        const rows = controls.listConversations(20);
        if (rows.length === 0) {
          ctx.io.write("  (no prior conversations)\n");
          return;
        }
        for (const r of rows) {
          const when = new Date(r.lastActivityAt).toISOString();
          ctx.io.write(`  #${r.id}  ${when}  (${r.messageCount} messages)\n`);
        }
        ctx.io.write("  type /resume <id> to load one\n");
        return;
      }
      if (!controls.resume) {
        ctx.io.write("  (this session doesn't support resuming)\n");
        return;
      }
      try {
        await controls.resume(requested);
        ctx.io.write(`  resumed conversation #${requested}\n`);
      } catch (err) {
        ctx.io.write(`  resume failed: ${(err as Error).message}\n`);
      }
    },
  };
}

export function statusCommand(controls: SessionControls): MetaCommand {
  return {
    name: "/status",
    description: "Show provider, model, db path, and current session id.",
    matches: (line) => line === "/status",
    run: (_line, ctx) => {
      if (!controls.status) {
        ctx.io.write("  (this session doesn't support /status)\n");
        return;
      }
      const fields = controls.status();
      for (const [k, v] of Object.entries(fields)) {
        ctx.io.write(`  ${k.padEnd(14)} ${v}\n`);
      }
    },
  };
}

// /reset is an alias for /clear — openclaw exposes both. We keep /clear
// as the canonical command and add /reset for muscle-memory compatibility.
export function resetCommand(controls: SessionControls): MetaCommand {
  return {
    name: "/reset",
    description: "Start a fresh conversation (alias of /clear).",
    matches: (line) => line === "/reset",
    async run(_line, ctx) {
      if (!controls.clear) {
        ctx.io.write("  (this session doesn't support /reset)\n");
        return;
      }
      await controls.clear();
      ctx.io.write("  (reset — started a new conversation)\n");
    },
  };
}

export function usageCommand(controls: SessionControls): MetaCommand {
  return {
    name: "/usage",
    description: "Show tool-call counts from the audit log for this database.",
    matches: (line) => line === "/usage",
    run: (_line, ctx) => {
      if (!controls.usage) {
        ctx.io.write("  (this session doesn't support /usage)\n");
        return;
      }
      const u = controls.usage();
      ctx.io.write(
        `  tool calls: ${u.total}  (ok=${u.ok}, failed=${u.failed})\n`,
      );
      if (u.bySkill.length === 0) {
        ctx.io.write("  (no tool calls yet)\n");
        return;
      }
      for (const row of u.bySkill.slice(0, 20)) {
        ctx.io.write(`  ${row.skill.padEnd(20)} ${row.count}\n`);
      }
    },
  };
}

function indentBlock(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

export function memoriesCommand(memory: MemoryStore): MetaCommand {
  return {
    name: "/memories",
    description: "Show recent memories: /memories [N] (default 10).",
    matches: (line) => /^\/memories(\s+\d+)?\s*$/.test(line),
    run: (line, ctx) => {
      const m = line.match(/^\/memories(?:\s+(\d+))?\s*$/);
      const n = m && m[1] ? Number(m[1]) : 10;
      const rows = memory.listRecent(n);
      if (rows.length === 0) {
        ctx.io.write("  (no memories yet — try \"remember that ...\")\n");
        return;
      }
      for (const rec of rows) {
        ctx.io.write(`  #${rec.id} [${rec.kind}] ${rec.content}\n`);
      }
    },
  };
}
