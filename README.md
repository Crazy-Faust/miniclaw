# miniclaw

A lightweight, local-first AI agent that maps natural-language requests to a small set of sandboxed skills, runs them on your machine, and keeps an auditable SQLite trail.

miniclaw is a pnpm workspace of small TypeScript packages. Interfaces live in `@miniclaw/core`; concrete implementations for LLMs, memory, context, skills, transports, and I/O sit behind those interfaces. The CLI is the composition root.

## Quick Start

```bash
git clone <this repo> miniclaw
cd miniclaw
pnpm setup
pnpm dev
```

`pnpm setup` installs dependencies, creates `.env`, prompts for an LLM provider key, offers the optional browser dependency, and runs the tests. Re-run it any time; it is idempotent.

Manual setup is also supported:

```bash
pnpm install
cp .env.example .env
pnpm test
pnpm dev
```

Requirements: Node.js 20+, pnpm 9+, and a native build toolchain for `better-sqlite3`.

## Running It

```bash
pnpm dev                         # interactive REPL
pnpm dev -- "what is 2+2?"       # one-shot prompt
pnpm dev -- chat                 # attach to the daemon and resume the cli channel
pnpm dev -- daemon run           # start just the daemon in the foreground
pnpm dev -- daemon start         # start just the daemon in the background
pnpm dev -- daemon status        # inspect the daemon
pnpm dev -- daemon stop          # stop the daemon
```

Normal launches auto-start a long-running gateway daemon and attach over a Unix socket. The daemon owns sessions, cron jobs, transports, persistence, and the agent instance. Use `--ephemeral` or `--stateless` when you want a one-process throwaway run with reduced state and no daemon transport layer.

## Configuration

At least one provider key is required:

```env
MINICLAW_PROVIDER=anthropic      # anthropic | openai | gemini
ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# GEMINI_API_KEY=...
```

Useful optional settings:

```env
MINICLAW_MODEL=                  # override provider default
MINICLAW_HOME=~/.miniclaw        # DB, socket, pid, logs
MINICLAW_WORKSPACE=/path/to/repo # filesystem and shell sandbox root
MINICLAW_SMALL_PROVIDER=openai   # compaction, dreaming, wiki maintenance, high-security checks
MINICLAW_SECURITY_MODE=off       # off | medium | high
MINICLAW_DISCORD_TOKEN=...       # enables Discord DM transport in the daemon
```

The small model is optional but useful for background and guardrail work. When `MINICLAW_SMALL_PROVIDER` is set, miniclaw uses that provider for context compaction, conversation dreaming, automatic memory-wiki maintenance, and `MINICLAW_SECURITY_MODE=high` tool-call checks. If it is unset, compaction and manual internal jobs fall back to the primary model, but automatic wiki maintenance does not run.

See [docs/REFERENCE.md](docs/REFERENCE.md#environment-variables--full-reference) for the full environment reference.

## Discord

The Discord transport runs inside the daemon and maps each paired DM sender to a gateway session.

1. Create a Discord application at [discord.com/developers/applications](https://discord.com/developers/applications), add a bot, and enable Message Content Intent.
2. Invite the bot with the `bot` scope and `Send Messages` plus `Read Message History` permissions. Add it to a server so Discord allows DMs.
3. Put the bot token in `.env` as `MINICLAW_DISCORD_TOKEN=...`.
4. Start the daemon with `pnpm dev -- daemon run` or `pnpm dev -- daemon start`.
5. DM the bot. Copy the pairing code from the daemon log and reply with `/pair <code>`.

After pairing, Discord DMs use channel `discord:dm:<user-id>` and can use the same daemon-backed skills as the CLI, including reminders and recurring cron prompts. See [docs/REFERENCE.md#discord-transport](docs/REFERENCE.md#discord-transport) for the full walkthrough.

## Architecture

The current runtime has one primary workflow:

1. CLI, one-shot, chat, Discord, or cron input reaches the gateway.
2. The gateway resolves a channel-backed session and gets an agent for that session.
3. The agent asks the context manager for recent conversation state and wiki-first memory retrieval.
4. The selected LLM either replies or requests a skill call.
5. Skill arguments pass validation, sandbox checks, optional confirmation, and optional high-security small-LLM review.
6. Results are audited to SQLite before returning to the model.

Package layout:

```text
packages/core/              shared interfaces and types
packages/agent/             tool-using agent loop
packages/cli/               composition root and CLI entrypoint
packages/gateway/           daemon, sessions, socket attach, cron scheduler
packages/harness/           reusable session loop and slash commands
packages/agent-skills/      SKILL.md discovery, built-in skills, script runner
packages/context-*/         windowed and stateless context strategies
packages/llm-*/             Anthropic, OpenAI-compatible, and Gemini providers
packages/memory-*/          SQLite, in-memory, vector, and wiki memory layers
packages/transport-discord/ Discord DM transport
packages/io-http/           HTTP/SSE wrapper
packages/dreaming/          background conversation reflection
```

For diagrams and deeper runtime flows, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Skills And Memory

Capabilities are agentskills.io-style `SKILL.md` folders. Built-ins live in `packages/agent-skills/skills/`; user skills are discovered from `<workspace>/skills/` and `$MINICLAW_HOME/skills/`.

The default SQLite memory path stores raw memories, conversations, audit logs, sessions, cron jobs, and a synthesized wiki. `search_memory` reads the wiki first and falls back to raw memory rows while maintenance is pending.

## More Docs

- [Detailed setup, usage, troubleshooting, and extension notes](docs/REFERENCE.md)
- [Architecture diagrams](docs/ARCHITECTURE.md)
- [Manual test checklist](docs/MANUAL_TESTS.md)
- [Entrypoint refactor notes](docs/REFACTOR-unify-entrypoints.md)

## Development

```bash
pnpm test
pnpm typecheck
pnpm -r typecheck
pnpm --filter @miniclaw/agent-skills test
```

Rule of thumb: packages should depend on `@miniclaw/core` interfaces where possible. `@miniclaw/cli` is the only package that wires concrete implementations together.
