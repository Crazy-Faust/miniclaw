export type Mode =
  | { kind: "repl"; stateless: boolean; ephemeral: boolean }
  | { kind: "one-shot"; prompt: string; stateless: boolean; ephemeral: boolean }
  | { kind: "daemon"; action: "run" | "start" | "stop" | "status" }
  | { kind: "chat"; channel: string }
  | { kind: "install"; target: "launchd" | "systemd" }
  | { kind: "help" };

export interface ParsedArgs {
  mode: Mode;
}

export const USAGE = `usage: miniclaw [subcommand|flags|prompt]

interactive / one-shot:
  miniclaw                              REPL (default)
  miniclaw "what is 2+2?"               one-shot, exit when done
  miniclaw --stateless                  no history / no retrieval
  miniclaw --ephemeral                  no disk persistence

daemon mode (Phase 1):
  miniclaw daemon run                   run the gateway in the foreground
  miniclaw daemon start                 fork into the background
  miniclaw daemon stop                  stop a running daemon
  miniclaw daemon status                "running" / "not running"
  miniclaw chat [--channel <name>]      attach to a running daemon
  miniclaw install launchd|systemd      write a service file (not loaded)

env vars:
  ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY
  MINICLAW_PROVIDER=anthropic|openai|gemini
  MINICLAW_MODEL                        provider-specific model name
  MINICLAW_BASE_URL                     OpenAI-compatible endpoint
  MINICLAW_SMALL_PROVIDER               optional small-task provider
  MINICLAW_SMALL_MODEL                  optional small-task model
  MINICLAW_SECURITY_MODE=off|medium|high
  MINICLAW_WIKI_BROWSER=on|off          local token-authenticated wiki browser
  MINICLAW_HOME                         data dir (default: ~/.miniclaw)
  MINICLAW_SOCKET                       daemon socket (default: \$HOME/miniclaw.sock)
  MINICLAW_DISCORD_TOKEN                if set, the daemon starts the Discord transport
`;

// Parse the argv vector. The first positional is checked for known
// subcommands; everything else falls through to REPL/one-shot mode so the
// historical UX (`miniclaw "tell me a joke"`) keeps working.
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  let stateless = false;
  let ephemeral = false;
  let help = false;
  let channel: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    else if (a === "--stateless") stateless = true;
    else if (a === "--ephemeral") ephemeral = true;
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--channel") {
      channel = argv[++i] ?? null;
      if (!channel) throw new Error("--channel requires a value");
    } else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else positionals.push(a);
  }

  if (help) return { mode: { kind: "help" } };

  const head = positionals[0];

  if (head === "daemon") {
    const action = (positionals[1] ?? "run") as "run" | "start" | "stop" | "status";
    if (!["run", "start", "stop", "status"].includes(action)) {
      throw new Error(`unknown daemon action: ${action}`);
    }
    return { mode: { kind: "daemon", action } };
  }

  if (head === "chat") {
    return { mode: { kind: "chat", channel: channel ?? "cli" } };
  }

  if (head === "install") {
    const target = positionals[1];
    if (target !== "launchd" && target !== "systemd") {
      throw new Error("install requires a target: launchd | systemd");
    }
    return { mode: { kind: "install", target } };
  }

  if (positionals.length > 0) {
    return {
      mode: {
        kind: "one-shot",
        prompt: positionals.join(" "),
        stateless,
        ephemeral,
      },
    };
  }

  return { mode: { kind: "repl", stateless, ephemeral } };
}
