import type { Agent, AgentTurnHooks } from "@miniclaw/agent";
import type { IOAdapter } from "./io.ts";
import { helpCommand, type MetaCommand, type MetaCommandContext } from "./meta.ts";

export interface HarnessOpts {
  agent: Agent;
  io: IOAdapter;
  /** Meta-commands evaluated in order; first match wins. */
  metaCommands?: MetaCommand[];
  /** Text printed once at session start. */
  banner?: string;
  /** Prompt shown before each readLine(). Defaults to "> ". */
  prompt?: string;
  /** Auto-register a /help that lists everything in metaCommands. Default true. */
  includeHelp?: boolean;
  /**
   * Optional PreToolUse / PostToolUse hooks. The harness forwards them to
   * each runTurn so consumers can intercept tool calls at the session
   * boundary (audit, gating, in-flight policy checks).
   */
  onPreToolUse?: AgentTurnHooks["onPreToolUse"];
  onPostToolUse?: AgentTurnHooks["onPostToolUse"];
}

// The session loop. Self-contained — once you give it an agent and an IO
// adapter it runs until /exit, EOF, or an unhandled error from the agent
// (handled errors are surfaced to the user).
export class Harness {
  private readonly agent: Agent;
  private readonly io: IOAdapter;
  private readonly prompt: string;
  private readonly banner: string | undefined;
  private readonly commands: MetaCommand[];
  private readonly onPreToolUse: AgentTurnHooks["onPreToolUse"];
  private readonly onPostToolUse: AgentTurnHooks["onPostToolUse"];
  private running = false;

  constructor(opts: HarnessOpts) {
    this.agent = opts.agent;
    this.io = opts.io;
    this.prompt = opts.prompt ?? "> ";
    this.banner = opts.banner;
    this.onPreToolUse = opts.onPreToolUse;
    this.onPostToolUse = opts.onPostToolUse;
    const user = opts.metaCommands ?? [];
    if (opts.includeHelp !== false) {
      // The /help command needs a reference to the full list AFTER help is
      // appended, so we close over the final array.
      const all: MetaCommand[] = [...user];
      const help = helpCommand(() => all);
      all.push(help);
      this.commands = all;
    } else {
      this.commands = user;
    }
  }

  async run(): Promise<void> {
    if (this.banner) this.io.write(this.banner.endsWith("\n") ? this.banner : this.banner + "\n");

    this.running = true;
    const ctx: MetaCommandContext = {
      io: this.io,
      stop: () => { this.running = false; },
    };

    while (this.running) {
      const line = await this.io.readLine(this.prompt);
      if (line === null) break;                    // EOF
      const trimmed = line.trim();
      if (trimmed === "") continue;                // blank input: re-prompt

      const cmd = this.commands.find((c) => c.matches(trimmed));
      if (cmd) {
        try {
          await cmd.run(trimmed, ctx);
        } catch (err) {
          this.io.write(`error in ${cmd.name}: ${(err as Error).message}\n`);
        }
        continue;
      }

      try {
        const streaming = !!this.io.onAssistantToken;
        const trace = await this.agent.runTurn(trimmed, {
          onTool: (name, args) => this.io.onToolCall?.(name, args),
          // Show narration emitted alongside a tool call so the UI isn't
          // silent across tool rounds. Streaming adapters already see this
          // via token deltas, so don't double-render.
          onIntermediateText: streaming
            ? undefined
            : (text) => {
                const t = text.trim();
                if (t.length > 0) this.io.write(`${t}\n`);
              },
          onAssistantToken: streaming
            ? (delta) => this.io.onAssistantToken!(delta)
            : undefined,
          onPreToolUse: this.onPreToolUse,
          onPostToolUse: this.onPostToolUse,
        });
        if (!streaming) {
          this.io.write(`\n${trace.finalText}\n\n`);
        }
      } catch (err) {
        this.io.write(`error: ${(err as Error).message}\n\n`);
      }
    }

    this.io.close();
  }
}
