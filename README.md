# miniclaw

A lightweight, local-first AI agent. It maps natural-language requests to a small set of safe tools, runs them on your machine, and keeps an auditable trail of everything in SQLite.

The repo is a **pnpm workspace** of 26 small packages. Every major subsystem (LLM provider, memory store, context strategy, skill, I/O, transport) is its own package behind an interface in `@miniclaw/core`, so each can be swapped or extended independently.

You can use miniclaw three ways:

- **Single REPL** — `pnpm dev` opens an interactive prompt; the agent and the conversation live in one process.
- **Daemon + attach** — `miniclaw daemon start` runs a long-lived gateway; `miniclaw chat` attaches to it over a Unix socket; the same daemon ticks scheduled jobs.
- **Daemon + transport** — set `MINICLAW_DISCORD_TOKEN` and the same daemon also answers Discord DMs, with a per-channel allowlist + pairing-code onboarding.

---

## Setup — the fast path

```bash
git clone <this repo> miniclaw
cd miniclaw
pnpm setup
```

The setup script checks your toolchain, runs `pnpm install`, seeds `.env` (prompts you for a provider and key), offers to install the optional browser dependency, and runs the test suite. It's idempotent — re-run any time. Flags: `--yes` (no prompts), `--skip-test`, `--no-deps`.

After it finishes:

```bash
pnpm dev                              # REPL
pnpm dev -- "what's 2+2?"             # one-shot
```

The longhand step-by-step is below if you want to know what `pnpm setup` actually does, or if your platform isn't covered (Windows users should use WSL).

---

## Setup — step by step

### 1. Prerequisites

You need:

- **Node.js ≥ 20** (tested on 20, 22, and 26)
- **pnpm ≥ 9** — install with `brew install pnpm` (macOS), `npm install -g pnpm`, or [other methods](https://pnpm.io/installation)
- A native toolchain (Xcode CLT on macOS, `build-essential` on Linux) — needed once to compile `better-sqlite3`

Optional, only if you want the matching feature:

- **Playwright** — required by `skills-browser`. `pnpm add -w playwright && pnpm exec playwright install chromium`. Not installed by default.

Check:

```bash
node --version    # should print v20.x or higher
pnpm --version    # should print 9.x or higher
```

### 2. Install

```bash
git clone <this repo> miniclaw
cd miniclaw
pnpm install
```

The first install compiles `better-sqlite3`'s native binding (this takes ~30s and only happens once).

### 3. Verify the install is healthy

Run the test suite — it uses fake LLMs, so **no API key is needed**:

```bash
pnpm test
```

You should see ~470 tests pass. If anything fails here, fix it before continuing.

### 4. Get an API key for at least one LLM provider

Pick one — you only need one to start:

| Provider | Where to get a key | Default model |
|---|---|---|
| **Anthropic Claude** (default) | https://console.anthropic.com → API Keys | `claude-sonnet-4-6` |
| OpenAI | https://platform.openai.com/api-keys | `gpt-4o-mini` |
| Google Gemini | https://aistudio.google.com/apikey | `gemini-2.0-flash` |

You can also point the OpenAI provider at a **local Ollama / LM Studio** server — see step 10.

### 5. Configure `.env`

```bash
cp .env.example .env
```

Open `.env` and fill in the variables you need. **Only `ANTHROPIC_API_KEY` (or the equivalent for your chosen provider) is required to start.**

```env
# --- LLM provider (REQUIRED) ---
ANTHROPIC_API_KEY=sk-ant-...                # one of these three (whichever
# OPENAI_API_KEY=sk-...                     # matches MINICLAW_PROVIDER)
# GEMINI_API_KEY=...
# MINICLAW_PROVIDER=anthropic               # anthropic | openai | gemini (default: anthropic)
# MINICLAW_MODEL=                           # override the per-provider default
# MINICLAW_BASE_URL=http://localhost:11434/v1   # OpenAI provider only — point at Ollama / LM Studio

# --- Data + sandbox ---
# MINICLAW_HOME=/path/to/data               # SQLite DB, daemon socket, PID file, logs (default: ~/.miniclaw)
# MINICLAW_WORKSPACE=/Users/you/projects    # fs / shell / browser sandbox root (default: cwd)

# --- Daemon (Phase 1, optional) ---
# MINICLAW_SOCKET=$HOME/.miniclaw/miniclaw.sock   # override the daemon's Unix socket path
# MINICLAW_PID=$HOME/.miniclaw/miniclaw.pid       # override the daemon's PID file path

# --- Transports (Phase 3, optional) ---
# MINICLAW_DISCORD_TOKEN=Mzk...             # if set, the daemon starts the Discord transport
```

A complete reference for every env variable lives at the bottom of this file.

### 6. First run — interactive REPL

```bash
pnpm dev
```

You should see:

```
miniclaw — provider anthropic, model claude-sonnet-4-6, db /Users/you/.miniclaw/miniclaw.db, windowed context
skills: write_memory, search_memory, shell, sql_query, read_file, list_directory, write_file, apply_patch, fetch_url,
        sessions_list, sessions_history, sessions_send, sessions_spawn,
        reminder_add, cron_add, cron_list, cron_remove, cron_pause,
        canvas_create, canvas_update, canvas_list, canvas_delete
type /help for slash commands, /exit to quit
>
```

(`web_search` shows up too if `MINICLAW_SEARCH_API_KEY` is set; the browser_* skills only appear if you've registered them and installed Playwright.)

### 7. Try the built-in skills

```
> remember that my preferred editor is helix
```

Calls `write_memory` and stores the fact in `~/.miniclaw/miniclaw.db`.

```
> what editor do I prefer?
```

Calls `search_memory`, finds the entry, answers "helix".

```
> list the files in the current directory
```

Calls `list_directory`. Sandboxed to `MINICLAW_WORKSPACE` (default: the cwd you started miniclaw from). Returns structured JSON.

```
> read the README and summarize the first section
```

Calls `read_file` (also sandboxed). Files outside the workspace are refused.

```
> show me the current date using the shell
```

Calls `shell` with `date`. The shell skill runs with `cwd` set to the workspace root and rejects any path argument that escapes it.

```
> how many tool calls have I made today?
```

Calls `sql_query` against the `audit_log` table.

Exit with:

```
> /exit
```

### 8. Inspect what was written

Everything the agent does is logged in `~/.miniclaw/miniclaw.db`:

```bash
sqlite3 ~/.miniclaw/miniclaw.db ".schema"
sqlite3 ~/.miniclaw/miniclaw.db "select * from memories;"
sqlite3 ~/.miniclaw/miniclaw.db "select ts, skill, ok, result_summary from audit_log order by ts desc limit 20;"
sqlite3 ~/.miniclaw/miniclaw.db "select id, channel, status, datetime(last_activity_at/1000, 'unixepoch') from sessions;"
```

Every tool call is captured **before** its result is returned to the model, so even a misbehaving model leaves a trail.

### 9. Other ways to run it

```bash
# One-shot mode — run one turn and exit:
pnpm dev -- "what time is it?"

# Stateless (no history, no retrieval):
pnpm dev -- --stateless "summarize this paragraph for me"

# Ephemeral (no disk writes — InMemoryStore):
pnpm dev -- --ephemeral

# Combined — zero-state one-shot:
pnpm dev -- --stateless --ephemeral "quick question"

# Help:
pnpm dev -- --help
```

The full subcommand surface:

```bash
miniclaw                              REPL (default)
miniclaw "what is 2+2?"               one-shot
miniclaw daemon run                   run the gateway in the foreground (logs to stdout)
miniclaw daemon start                 fork the daemon into the background
miniclaw daemon stop                  send SIGTERM to the running daemon
miniclaw daemon status                "running" / "not running"
miniclaw chat [--channel <name>]      attach to a running daemon over its Unix socket
miniclaw install launchd              write ~/Library/LaunchAgents/com.miniclaw.gateway.plist
miniclaw install systemd              write ~/.config/systemd/user/miniclaw-gateway.service
```

### 10. Switch LLM providers

No code change — just an env var:

```bash
MINICLAW_PROVIDER=openai  OPENAI_API_KEY=sk-...  pnpm dev
MINICLAW_PROVIDER=gemini  GEMINI_API_KEY=...     pnpm dev

# Local Ollama (uses the openai package via baseURL override):
MINICLAW_PROVIDER=openai \
  OPENAI_API_KEY=ollama \
  MINICLAW_BASE_URL=http://localhost:11434/v1 \
  MINICLAW_MODEL=llama3.1 \
  pnpm dev
```

---

## Daemon mode

The daemon is a long-running gateway that supervises sessions, ticks the cron scheduler, and (optionally) runs transports.

```bash
pnpm dev -- daemon run        # foreground, watch logs
pnpm dev -- daemon start      # detach into background
pnpm dev -- daemon status     # show pid + socket path
pnpm dev -- daemon stop       # SIGTERM the running daemon
```

While the daemon is up, attach an interactive REPL with:

```bash
pnpm dev -- chat                       # default channel "cli"
pnpm dev -- chat --channel myroom      # join a named channel
```

Multiple `chat` clients can attach in parallel — each channel is its own session with its own conversation history. The agent itself lives in the daemon; `chat` only shuttles input/output over `$MINICLAW_HOME/miniclaw.sock`.

### Auto-start on login

Once you've confirmed the daemon works:

```bash
# macOS
pnpm dev -- install launchd
launchctl load -w ~/Library/LaunchAgents/com.miniclaw.gateway.plist

# Linux (systemd user session)
pnpm dev -- install systemd
systemctl --user daemon-reload
systemctl --user enable --now miniclaw-gateway
```

`install` only writes the template file — loading it is an explicit follow-up step. Daemon stdout/stderr go to `$MINICLAW_HOME/daemon.out.log` and `daemon.err.log`.

### Scheduling reminders and recurring prompts

Once a daemon is running, ask the agent to schedule a job:

```
> remind me in 30 seconds to take out the trash
  · tool reminder_add({"message":"take out the trash","delaySeconds":30})
scheduled reminder #1

> remind me every 15 minutes to stretch
  · tool cron_add({"name":"stretch","prompt":"remind me to stretch","schedule":"@every 15m"})
scheduled job #1
```

Reminders use one-shot `@once` jobs; recurring prompts use `@every`. Both are persisted in SQLite and survive daemon restarts. List or cancel them with `cron_list` / `cron_remove` (the agent will pick the right tool from a natural-language ask).

Schedule syntax: `@once` or `@every <N>(s|m|h|d)`. Real cron expressions are intentionally deferred.

---

## Discord transport

The daemon can also listen for Discord DMs. Per-channel allowlist + pairing-code onboarding gates strangers out.

1. Create a Discord application at https://discord.com/developers/applications and add a Bot. Enable **MESSAGE CONTENT INTENT** under "Privileged Gateway Intents". Copy the bot token.
2. Invite the bot (OAuth2 → URL Generator → `bot` scope, `Send Messages` + `Read Message History`). Discord requires a mutual server for DMs, so even if you only want DMs, add the bot to a throwaway server.
3. Add to `.env`: `MINICLAW_DISCORD_TOKEN=Mzk...`
4. `pnpm dev -- daemon run`. Look for the line `miniclaw daemon: discord transport connected`.
5. DM the bot anything. The bot replies asking for a pairing code. In the daemon log you'll see:
   ```
   discord: pairing requested by yourname (12345...) — code ABC23XYZ expires ...
   ```
6. DM the bot `/pair ABC23XYZ`. It replies `paired — go ahead and ask me anything.`

From then on your DMs flow into the agent as channel `discord:dm:<your-user-id>`. Codes are single-use and expire in 10 minutes. The allowlist is persisted in SQLite under `channel_allowlist`. The Discord session gets the same daemon skills as the CLI, including `reminder_add`, `cron_*`, `sessions_*`, and `canvas_*`; scheduled reminders store the Discord DM channel and send their final reminder text back to that DM.

---

## Project conventions: AGENTS.md / TOOLS.md

If your workspace has an `AGENTS.md` or `TOOLS.md` at the workspace root (whatever `MINICLAW_WORKSPACE` points at, or `cwd` by default), the windowed context manager reads them once at startup and appends them to the system prompt. Each file is capped at 32 KB.

Use them to encode project-specific style, preferred tools, or guardrails:

```
# AGENTS.md
Reply in short, terse sentences.
Before using `shell`, prefer `read_file` / `list_directory` if the question is about file contents.
```

Restart the agent (`/exit` and `pnpm dev` again, or `daemon stop` + `daemon start`) to pick up edits.

---

## Slash commands (interactive mode)

```
/help           List all slash commands.
/skills         List registered skills.
/memories [N]   Show the N most recent memories (default 10).
/status         Provider, model, db path, current conversation id, workspace, skill count.
/usage          Tool-call counts from the audit log (total + by skill).
/reset          Start a fresh conversation (alias of /clear).
/compact        Summarize older turns to free up context budget.
/dream          Review recent conversations and extract useful memories/tasks.
/make_skill     Scaffold a brand-new skill package and register it.
/exit, /quit    End the session.
```

Add your own by implementing `MetaCommand` from `@miniclaw/harness`. Meta commands can be async, so they can prompt the user across multiple turns via `ctx.io.readLine`.

### `/make_skill` walkthrough

Inside the REPL, type `/make_skill`. It prompts you for four things:

```
> /make_skill
Scaffolding a new skill. Press Ctrl-D / EOF at any prompt to cancel.
Skill package name (kebab-case, e.g. fetch-url): fetch-url
Tool name shown to the LLM (snake_case, e.g. fetch_url) [fetch_url]:
One-line description: Fetch a URL and return the body.
Parameters (e.g. 'url:string, timeout:number?'; blank for none): url:string, timeout:number?

Created packages/skills-fetch-url with:
  package.json
  tsconfig.json
  src/skill.ts
  src/index.ts
  tests/skill.test.ts
Registration: skills.ts updated, cli/package.json updated

Next steps:
  1. pnpm install
  2. open packages/skills-fetch-url/src/skill.ts and implement execute()
  3. pnpm typecheck && pnpm test
```

The generated `src/skill.ts` ships with a `return fail("not implemented")` body and a TODO comment listing what's on `args` and `ctx`. The CLI's `buildRegistry()` now includes your new skill — restart `pnpm dev` and it shows up under `/skills`.

**Parameter mini-language** for the wizard:

| Form | Meaning |
|---|---|
| `name:string` | required string |
| `name:number?` | optional number |
| `name:boolean` | required boolean |
| `name:string[]` | required array of strings |
| `name:number[]?` | optional array of numbers |

Comma-separated. Blank input means no parameters.

---

## Troubleshooting

**`ANTHROPIC_API_KEY is not set`** — your `.env` is missing the key for the selected provider. Either set the right key or change `MINICLAW_PROVIDER`.

**`better-sqlite3` fails to compile** — make sure your native toolchain is installed (`xcode-select --install` on macOS). If you're on a very new Node version, run `pnpm add -D better-sqlite3@latest` in the workspace root.

**`Ignored build scripts`** during install — pnpm 11 requires explicit approval for native builds. `pnpm-workspace.yaml` already approves `better-sqlite3` and `esbuild`. Re-run `pnpm install`.

**The agent isn't calling tools** — make sure the model you're using supports tool calling. Claude Sonnet, GPT-4o, and Gemini 2.0 Flash all do. Older or stripped-down models may not.

**`refused: bin 'X' is not on the allowlist`** — that's the shell skill's security guard working as intended. The allowlist is in `packages/skills-shell/src/security.ts` if you want to extend it (review carefully — these binaries run on your machine).

**`playwright is not installed`** — the `browser_*` skills need it. `pnpm add -w playwright && pnpm exec playwright install chromium`.

**`discord.js could not be loaded`** — the install is incomplete or corrupted. Run `pnpm install` from the repo root and retry.

**`no daemon at /Users/you/.miniclaw/miniclaw.sock`** — you ran `miniclaw chat` without starting the daemon first. `miniclaw daemon start`.

**Discord bot replies "this account is not paired"** — that's correct on first contact. Look in the daemon log for the line `discord: pairing requested by ... — code XYZ…`, then DM the bot `/pair XYZ…`. Codes expire after 10 minutes.

---

## Package map

```
packages/
├── core/                 Interfaces + skill SDK. No miniclaw-internal deps.
│                         (LLMProvider, Skill, MemoryStore, ConversationStore,
│                          AuditSink, SessionStore, CronStore, ChannelAllowlist,
│                          PairingStore, Transport, ContextManager)
│
│  ── storage backends
├── memory-sqlite/        SqliteStore — persistent. Implements every store interface.
├── memory-inmemory/      InMemoryStore — no disk, for tests / ephemeral runs.
├── memory-vector/        Embedding-based memory retrieval (alternative to FTS5).
│
│  ── LLM providers
├── llm-anthropic/        Claude.
├── llm-openai/           OpenAI — also OpenAI-compatible servers (Ollama, LM Studio).
├── llm-gemini/           Google Gemini.
│
│  ── skills
├── skills-shell/         shell exec with allowlist + arg guard + workspace sandbox.
├── skills-db/            read-only sql_query against the local DB.
├── skills-fs/            read_file, list_directory, write_file, apply_patch (sandboxed).
├── skills-memory/        write_memory + search_memory.
├── skills-web/           fetch_url + web_search (provider-keyed).
├── skills-todo/          todo_write — persistent multi-step plan across turns.
├── skills-sessions/      sessions_list/history/send/spawn — drives the gateway.
├── skills-cron/          cron_add/list/remove/pause — read by the gateway scheduler.
├── skills-canvas/        canvas_create/update/list/delete — HTML scratchpad pages.
├── skills-browser/       browser_open/read_page/screenshot/click/fill — Playwright-backed.
│
│  ── context strategies
├── context-windowed/     Sliding window + memory retrieval + AGENTS.md/TOOLS.md injection.
├── context-stateless/    System + new user message only. No history, no retrieval.
│
│  ── orchestration
├── agent/                Agent.runTurn — one user turn end-to-end. Depends on core ONLY.
├── dreaming/             Background reflection over conversations using normal skills.
├── harness/              Session loop + meta-commands. Reads input via IOAdapter.
├── gateway/              Long-running daemon: SessionRegistry, CronScheduler,
│                         Unix-socket attach, launchd/systemd templates.
│
│  ── transports + IO
├── io-http/              POST /chat → SSE token/tool/final stream.
├── transport-discord/    Discord bot → gateway.attach(channel).send(), with
│                         pairing-code onboarding.
└── cli/                  REPL + one-shot + daemon + chat + install. The only
                          package that wires concrete impls together.
```

### Dependency direction

```
                          core  ◀──────── every other package
                           ▲
                           │
       memory-*, llm-*, skills-*, context-*, agent, harness, gateway, transport-*
                           ▲
                           │
                          cli    (the only multi-impl importer)
```

Rule of thumb: if you're not in `cli`, you should not import another package's concrete classes — only `@miniclaw/core` types.

---

## How to add a new...

- **Skill**: create `packages/skills-<name>/`, depend on `@miniclaw/core` + `zod`, export a `Skill`. Register it in `cli/src/skills.ts`. The `/make_skill` wizard does most of the boilerplate.
- **LLM provider**: create `packages/llm-<name>/`, implement `LLMProvider`. Add a case in `cli/src/llm.ts` and an entry in `cli/src/config.ts`'s defaults.
- **Memory backend**: create `packages/memory-<name>/`, implement `MemoryStore` (and optionally `ConversationStore`, `AuditSink`, `SessionStore`, `CronStore`, `ChannelAllowlist`, `PairingStore`). Swap construction in `cli/src/main.ts`.
- **Context strategy**: create `packages/context-<name>/`, implement `ContextManager`. Swap construction in `cli/src/main.ts`.
- **Front-end** (HTTP, TUI, etc.): implement `IOAdapter` from `@miniclaw/harness` and call `Harness.run()`. No agent / skills / store changes needed.
- **Transport** (Telegram, Slack, Matrix, ...): create `packages/transport-<name>/`, implement `Transport` from `@miniclaw/core`. Wire it into the daemon in `cli/src/daemon.ts` (gate on an env var like `MINICLAW_TELEGRAM_TOKEN`).

---

## Dev workflow

```bash
pnpm test                              # run all tests from root
pnpm typecheck                         # typecheck the whole workspace
pnpm -r typecheck                      # typecheck each package independently
pnpm --filter @miniclaw/skills-shell test       # one package's tests
pnpm --filter @miniclaw/skills-shell typecheck  # one package's types
```

Per-package commands let two people work in two different packages without rebuilding the world.

---

## Built-in skills

| Skill | What it does | Security |
|---|---|---|
| `write_memory` | Persists a fact, preference, or note to long-term memory. | None — pure write to the local DB. |
| `search_memory` | Token-overlap (FTS5 in SQLite mode) search over prior memories. | None — pure read. |
| `read_file` | Reads a UTF-8 text file as a string (capped at 64KB). | Path must resolve under `MINICLAW_WORKSPACE`. Symlinks pointing out are refused. |
| `list_directory` | Lists directory entries as JSON: `{name, kind, size}`. | Same workspace sandbox as `read_file`. |
| `write_file` | Write or overwrite a UTF-8 text file. | Workspace-sandboxed. |
| `apply_patch` | Apply a unified diff to files. | Workspace-sandboxed; refuses paths outside. |
| `shell` | Runs an allowlisted binary with argv args. | Allowlist (`ls`, `cat`, `git`, `grep`, …), no shell interpolation, 10s timeout, 64KB output cap. `cwd` anchored to `MINICLAW_WORKSPACE`; any arg containing `/` must resolve inside. |
| `sql_query` | Read-only SELECT against the local SQLite DB. | Opens DB read-only, blocks non-SELECT, blocks multi-statement queries, blocks ATTACH/PRAGMA assignments. |
| `fetch_url` | HTTP GET, returns the body as text. | Optional allowlist via `MINICLAW_WEB_ALLOWLIST` (comma-separated origins). |
| `web_search` | Provider-backed web search. | Only registered when `MINICLAW_SEARCH_API_KEY` is set. |
| `todo_write` | Maintain a multi-step plan across turns. | Pure write to an in-process store. |
| `sessions_list` / `_history` / `_send` / `_spawn` | Drive the gateway's session registry. | Pure store operations. |
| `reminder_add`, `cron_add` / `_list` / `_remove` / `_pause` | Schedule one-shot reminders and recurring prompts persisted in SQLite. | The gateway's `CronScheduler` ticks them and returns proactive results to the originating channel when available. |
| `canvas_create` / `_update` / `_list` / `_delete` | Author HTML scratchpad pages mountable on the io-http server. | In-memory store; never touches disk. |
| `browser_open` / `_read_page` / `_screenshot` | Read-only Playwright tier. | Screenshot paths sandboxed to workspace. |
| `browser_click` / `_fill` | Interactive Playwright tier. | `requiresConfirmation: true` — fails closed in one-shot mode. |

All tool stdout is wrapped in `<tool_output>...</tool_output>` markers, and the system prompt tells the model to treat that content as data, not instructions — first line of defense against prompt injection from tool output.

### Per-skill confirmation prompts

Any skill can opt into a user confirmation prompt by setting `requiresConfirmation: true`. In interactive mode the readline IO prompts `approve <skill>(<args>)? [y/N]`. In one-shot mode (no `confirm` method on the IO), the agent **fails closed** — sensitive skills refuse to run. `browser_click` and `browser_fill` set this; the rest don't by default.

---

## Environment variables — full reference

| Variable | Purpose | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API key. Required when `MINICLAW_PROVIDER=anthropic`. | — |
| `OPENAI_API_KEY` | OpenAI API key. Required when `MINICLAW_PROVIDER=openai`. | — |
| `GEMINI_API_KEY` | Google Gemini API key. Required when `MINICLAW_PROVIDER=gemini`. | — |
| `MINICLAW_PROVIDER` | `anthropic` \| `openai` \| `gemini`. | `anthropic` |
| `MINICLAW_MODEL` | Override the per-provider default model name. | provider default |
| `MINICLAW_BASE_URL` | OpenAI-compatible endpoint (Ollama, LM Studio, …). OpenAI provider only. | OpenAI's URL |
| `MINICLAW_HOME` | Data directory for SQLite, daemon socket, PID file, daemon logs. | `~/.miniclaw` |
| `MINICLAW_WORKSPACE` | Filesystem sandbox root for `read_file`, `list_directory`, `write_file`, `apply_patch`, `shell`, `browser_screenshot`. Also where `AGENTS.md`/`TOOLS.md` are looked up. | `process.cwd()` |
| `MINICLAW_SOCKET` | Override the daemon's Unix socket path. | `$MINICLAW_HOME/miniclaw.sock` |
| `MINICLAW_PID` | Override the daemon's PID file path. | `$MINICLAW_HOME/miniclaw.pid` |
| `MINICLAW_WEB_ALLOWLIST` | Comma-separated origins `fetch_url` is allowed to call. Unset = no allowlist (any URL). | — |
| `MINICLAW_SEARCH_API_KEY` | Enables the `web_search` skill (Brave / Tavily / etc., depending on `MINICLAW_SEARCH_PROVIDER`). | — |
| `MINICLAW_SEARCH_PROVIDER` | Which search backend to use when the search skill is enabled. | provider default |
| `MINICLAW_DISCORD_TOKEN` | Bot token. If set, the daemon starts the Discord transport on `daemon run`. | — |

`install launchd|systemd` forwards exactly the variables above into the generated service file; everything else in your shell environment stays out of the service environment.
