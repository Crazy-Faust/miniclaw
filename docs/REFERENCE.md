# miniclaw

This is the extended setup and usage reference moved out of the root README.
Start with [../README.md](../README.md) for the concise overview.

A lightweight, local-first AI agent. It maps natural-language requests to a small set of safe tools, runs them on your machine, and keeps an auditable trail of everything in SQLite.

The repo is a **pnpm workspace** of 18 small packages. Every major subsystem (LLM provider, memory store, context strategy, tools, I/O, transport) is its own package behind an interface in `@miniclaw/core`, so each can be swapped or extended independently. Capabilities are delivered as [agentskills.io](https://agentskills.io/)-standard `SKILL.md` folders: the built-ins ship in `@miniclaw/agent-skills`, and you can drop your own into `<workspace>/skills/` or `$MINICLAW_HOME/skills/`.

There's **one workflow**: however you start a session, miniclaw ensures a gateway daemon is running (spawning one if absent) and attaches to it over a Unix socket. The daemon owns the agent and keeps running after you detach, so cron and transports are always available.

- **Attach** — `pnpm dev` (REPL), `pnpm dev -- "prompt"` (one-shot), and `miniclaw chat` all auto-start the daemon and attach as clients.
- **Transport** — set `MINICLAW_DISCORD_TOKEN` and the same daemon also answers Discord DMs, with a per-channel allowlist + pairing-code onboarding.
- **In-process bypass** — `--ephemeral` or `--stateless` skip the daemon and run a throwaway agent in one process (no cron/transports), for quick zero-state questions.

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
pnpm dev                              # REPL (auto-starts a daemon, attaches)
pnpm dev -- "what's 2+2?"             # one-shot (same daemon, then exits)
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

- **Playwright** — required by the `browser` skill (in `@miniclaw/agent-skills`). `pnpm add -w playwright && pnpm exec playwright install chromium`. Not installed by default.

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

You should see 500+ tests pass. If anything fails here, fix it before continuing.

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

# --- Optional small LLM + security ---
# MINICLAW_SMALL_PROVIDER=openai            # anthropic | openai | gemini
# MINICLAW_SMALL_MODEL=gpt-4o-mini
# MINICLAW_SMALL_API_KEY=sk-...             # optional explicit key
# MINICLAW_SMALL_API_KEY_VAR=OPENAI_API_KEY # optional env var to read instead
# MINICLAW_SMALL_BASE_URL=http://localhost:11434/v1
# MINICLAW_SECURITY_MODE=off                # off | medium | high

# --- Local wiki browser ---
# MINICLAW_WIKI_BROWSER=on                  # on | off
# MINICLAW_WIKI_BROWSER_PORT=0              # 0 = random available port

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

The first run spawns a daemon in the background (takes a second or two), then attaches to it. You should see:

```
attached to daemon on /Users/you/.miniclaw/miniclaw.sock, channel=cli
type /help for slash commands, /exit to detach
  · attached to session 4b1f0c9a-…
>
```

`/exit` only **detaches** — the daemon keeps running (and the wiki browser it started stays up). A second `pnpm dev` reuses the same daemon. List tools with `/skills`; stop the daemon with `pnpm dev -- daemon stop`. To run a throwaway agent in one process instead (no daemon), use `--ephemeral` or `--stateless`.

### 7. Try the built-in skills

```
> remember that my preferred editor is helix
```

Calls `write_memory`, stores the fact as raw source material in `~/.miniclaw/miniclaw.db`,
and queues wiki maintenance when SQLite is in use.

```
> what editor do I prefer?
```

Calls `search_memory`, which reads the compiled memory wiki first and falls back to
raw source rows until maintenance has integrated them.

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
sqlite3 ~/.miniclaw/miniclaw.db "select path, title, updated_at from wiki_pages order by updated_at desc limit 20;"
sqlite3 ~/.miniclaw/miniclaw.db "select ts, skill, ok, result_summary from audit_log order by ts desc limit 20;"
sqlite3 ~/.miniclaw/miniclaw.db "select id, channel, status, datetime(last_activity_at/1000, 'unixepoch') from sessions;"
```

Every tool call is captured **before** its result is returned to the model, so even a misbehaving model leaves a trail.

### 9. Other ways to run it

```bash
# One-shot — auto-starts the daemon, runs one turn, exits (daemon stays up):
pnpm dev -- "what time is it?"

# Resume the channel's session instead of a fresh one:
pnpm dev -- --resume

# Stateless (in-process bypass — no history/retrieval, no daemon):
pnpm dev -- --stateless "summarize this paragraph for me"

# Ephemeral (in-process bypass — no disk writes, InMemoryStore):
pnpm dev -- --ephemeral

# Combined — zero-state one-shot:
pnpm dev -- --stateless --ephemeral "quick question"

# Help:
pnpm dev -- --help
```

The full subcommand surface:

```bash
miniclaw                              REPL — auto-starts a daemon and attaches
miniclaw "what is 2+2?"               one-shot — same, runs one turn, then exits
miniclaw --channel <name>             attach on a named channel (default: cli)
miniclaw --resume                     resume the channel's session, not a fresh one
miniclaw --ephemeral | --stateless    in-process bypass (no daemon, no cron/transports)
miniclaw chat [--channel <name>]      attach to the daemon (resumes the channel)
miniclaw daemon run                   run the gateway in the foreground (logs to stdout)
miniclaw daemon start                 fork the daemon into the background
miniclaw daemon stop                  send SIGTERM to the running daemon
miniclaw daemon status                "running" / "not running"
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

The daemon is a long-running gateway that supervises sessions, ticks the cron scheduler, and (optionally) runs transports. Normal launches (`miniclaw`, `miniclaw "prompt"`, `miniclaw chat`) **auto-start** it, so you rarely run these by hand — they're for managing the daemon's lifecycle explicitly:

```bash
pnpm dev -- daemon run        # foreground, watch logs
pnpm dev -- daemon start      # detach into background
pnpm dev -- daemon status     # show pid + socket path
pnpm dev -- daemon stop       # SIGTERM the running daemon
```

Attach to it (each of these auto-starts the daemon if it isn't already running):

```bash
pnpm dev                               # repl on channel "cli", fresh session
pnpm dev -- chat                       # resume channel "cli"
pnpm dev -- chat --channel myroom      # join a named channel
```

Multiple clients can attach in parallel — each channel is its own session with its own conversation history. The agent itself lives in the daemon; the client only shuttles input/output over `$MINICLAW_HOME/miniclaw.sock`, plus a couple of host-local commands (`/make_skill` scaffolds into your workspace; tool-confirmation prompts are answered client-side).

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

## Small LLM, Memory Wiki, And Dreaming

`MINICLAW_SMALL_PROVIDER` configures an optional second model with the same provider interface as the primary model. When set, miniclaw uses it for internal lower-cost work: context compaction, conversation dreaming, automatic memory-wiki maintenance, and high-security tool-call checks. If unset, compaction and manual internal jobs use the primary model; automatic wiki maintenance does not start.

Long-term memory is wiki-first in SQLite mode:

- `write_memory` stores an immutable raw source row in `memories`, adds metadata, and queues a `memory_write` maintenance job.
- `MemoryWikiWorker` drains that queue in long-running REPL/daemon sessions only when a small LLM is configured.
- `/wiki_maintain` or the `wiki_maintain` skill can manually drain queued jobs.
- The maintainer asks the model for strict JSON actions and applies them through typed SQLite methods only. Raw memory rows are never automatically deleted.
- `search_memory` returns synthesized wiki pages first. Automatic context retrieval injects only a query-scoped memory index, so the model must call `wiki_read` or `search_memory` before relying on the full memory content. Active raw source rows are used as fallback index entries while no matching wiki page exists.

`/dream` runs a bounded background review of recent conversations with truncated tool calls. It uses normal skills to write useful source memories or schedule clear follow-up work, and it is also covered by high-security tool gating when that mode is enabled.

The local wiki browser starts automatically for long-running SQLite REPL/daemon sessions unless `MINICLAW_WIKI_BROWSER=off`. Open the URL shown in the REPL banner or `/status` to browse folders, pages, tags, source-memory ids, search results, and user-only LLM usage statistics. It binds to `127.0.0.1` by default and requires the random token in the URL or an `Authorization: Bearer ...` header.

LLM usage is recorded for primary and small-model calls when SQLite storage is active. The browser exposes it as a protected system page generated from `llm_usage_events`, with breakdowns by task type, model role, model, channel/job, and recent calls. That distinguishes actual user messages from cron jobs, context compaction, wiki maintenance, dreaming, and high-security tool checks. The page is for the user only: normal wiki search/read/list skills and automatic context retrieval hide it from the LLM, and model-generated wiki maintenance actions cannot modify it.

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
/status         Provider, model, small model, security mode, db path, current conversation id, workspace, skill count.
/usage          Tool-call counts from the audit log (total + by skill). LLM token usage is in the wiki browser.
/reset          Start a fresh conversation (alias of /clear).
/compact        Summarize older turns to free up context budget.
/dream          Review recent conversations and extract useful memories/tasks.
/wiki_maintain  Drain queued memory-to-wiki maintenance jobs.
/make_skill     Scaffold a new SKILL.md skill folder.
/exit, /quit    End the session.
```

Add your own by implementing `MetaCommand` from `@miniclaw/harness`. Meta commands can be async, so they can prompt the user across multiple turns via `ctx.io.readLine`.

### `/make_skill` walkthrough

Inside the REPL, type `/make_skill`. It scaffolds an [agentskills.io](https://agentskills.io/)-standard `SKILL.md` folder:

```
> /make_skill
Scaffolding a new SKILL.md skill. Press Ctrl-D / EOF at any prompt to cancel.
Skill name (kebab-case, e.g. pdf-tools): pdf-tools
One-line description (what it does + when to use it): Extract text and fill forms in PDFs.
Bundle a script? (none/python/node/bash) [none]: python
Script file name [run.py]: extract.py

Created <workspace>/skills/pdf-tools with:
  SKILL.md
  scripts/extract.py
The skill is discovered automatically next time miniclaw starts
(it scans <workspace>/skills and $MINICLAW_HOME/skills).
Run its script with run_skill_script(skill="pdf-tools", script="scripts/extract.py").
Open pdf-tools/SKILL.md and write the instructions.
```

A skill is a folder with a `SKILL.md` (YAML frontmatter — `name`, `description` — plus markdown
instructions) and, optionally, bundled `scripts/`, `references/`, and `assets/`. There is nothing to
register: at startup miniclaw discovers every skill folder, injects each skill's name + description
into the system prompt, and the model loads the full instructions on demand with the **`use_skill`**
tool. Bundled scripts run through the sandboxed **`run_skill_script`** tool (interpreter chosen by
extension — `.py`→python3, `.mjs`/`.js`→node, `.sh`→bash; the script path must stay inside the skill
folder). Edit the generated `SKILL.md` to describe the task; no restart is needed to pick up edits to
the body, only to discover a brand-new folder.

Built-in skills (filesystem, shell, database, web, memory) are the same format — they live in
`packages/agent-skills/skills/` and back their tools with an in-process `handler.ts` at the
skill-folder root (so `scripts/` stays reserved for genuine standalone scripts).

---

## Troubleshooting

**`ANTHROPIC_API_KEY is not set`** — your `.env` is missing the key for the selected provider. Either set the right key or change `MINICLAW_PROVIDER`.

**`better-sqlite3` fails to compile** — make sure your native toolchain is installed (`xcode-select --install` on macOS). If you're on a very new Node version, run `pnpm add -D better-sqlite3@latest` in the workspace root.

**`Ignored build scripts`** during install — pnpm 11 requires explicit approval for native builds. `pnpm-workspace.yaml` already approves `better-sqlite3` and `esbuild`. Re-run `pnpm install`.

**The agent isn't calling tools** — make sure the model you're using supports tool calling. Claude Sonnet, GPT-4o, and Gemini 2.0 Flash all do. Older or stripped-down models may not.

**`refused: bin 'X' is not on the allowlist`** — that's the shell skill's security guard working as intended. The allowlist is in `packages/agent-skills/src/lib/shell-security.ts` if you want to extend it (review carefully — these binaries run on your machine).

**`playwright is not installed`** — the `browser_*` skills need it. `pnpm add -w playwright && pnpm exec playwright install chromium`.

**`discord.js could not be loaded`** — the install is incomplete or corrupted. Run `pnpm install` from the repo root and retry.

**`daemon failed to start within 10s`** — a launch auto-started a daemon but it never opened its socket. The tail of `$MINICLAW_HOME/daemon.err.log` is printed with the cause (usually a bad/missing provider key or the port already in use). Fix that and retry, or run in one process with `--ephemeral` / `--stateless`.

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
├── memory-sqlite/        SqliteStore — persistent. Implements memory, wiki,
│                         knowledge, maintenance queue, conversation, audit,
│                         session, cron, allowlist, and pairing interfaces.
├── memory-inmemory/      InMemoryStore — no disk, for tests / ephemeral runs.
├── memory-vector/        Embedding-based memory retrieval (alternative to FTS5).
├── memory-wiki/          LLM-maintained SQLite wiki over raw source memories.
│
│  ── LLM providers
├── llm-anthropic/        Claude.
├── llm-openai/           OpenAI — also OpenAI-compatible servers (Ollama, LM Studio).
├── llm-gemini/           Google Gemini.
│
│  ── skills
├── agent-skills/         agentskills.io SKILL.md system: discovery, catalog, use_skill,
│                         run_skill_script, + ALL bundled built-ins (filesystem, shell,
│                         database, web, memory, cron, sessions, canvas, todo, browser).
│                         Runtime-bound ones (cron, sessions) are wired via the ./runtime
│                         subpath; browser is gated on the optional playwright peer.
│
│  ── context strategies
├── context-windowed/     Sliding window + wiki-first memory index retrieval +
│                         compaction + AGENTS.md/TOOLS.md injection.
├── context-stateless/    System + new user message only. No history, no retrieval.
│
│  ── orchestration
├── agent/                Agent.runTurn — one user turn end-to-end, including
│                         optional high-security tool-call guard. Depends on core ONLY.
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

- **Skill**: run `/make_skill` (or just drop a folder) to create an [agentskills.io](https://agentskills.io/) `SKILL.md` skill under `<workspace>/skills/` or `$MINICLAW_HOME/skills/` — it's discovered automatically, with no registration. To add an in-process built-in *tool*, create `packages/agent-skills/skills/<name>/` (`SKILL.md` + `handler.ts`) and add one line to `packages/agent-skills/src/builtins/index.ts`.
- **LLM provider**: create `packages/llm-<name>/`, implement `LLMProvider`. Add a case in `cli/src/llm.ts` and an entry in `cli/src/config.ts`'s defaults.
- **Memory backend**: create `packages/memory-<name>/`, implement `MemoryStore` (and optionally `KnowledgeStore`, `WikiStore`, `MemoryMaintenanceQueue`, `ConversationStore`, `AuditSink`, `SessionStore`, `CronStore`, `ChannelAllowlist`, `PairingStore`). Swap construction in `cli/src/main.ts`.
- **Context strategy**: create `packages/context-<name>/`, implement `ContextManager`. Swap construction in `cli/src/main.ts`.
- **Front-end** (HTTP, TUI, etc.): implement `IOAdapter` from `@miniclaw/harness` and call `Harness.run()`. No agent / skills / store changes needed.
- **Transport** (Telegram, Slack, Matrix, ...): create `packages/transport-<name>/`, implement `Transport` from `@miniclaw/core`. Wire it into the daemon in `cli/src/daemon.ts` (gate on an env var like `MINICLAW_TELEGRAM_TOKEN`).

---

## Dev workflow

```bash
pnpm test                              # run all tests from root
pnpm typecheck                         # typecheck the whole workspace
pnpm -r typecheck                      # typecheck each package independently
pnpm --filter @miniclaw/agent-skills test       # one package's tests
pnpm --filter @miniclaw/agent-skills typecheck  # one package's types
```

Per-package commands let two people work in two different packages without rebuilding the world.

---

## Built-in skills

| Skill | What it does | Security |
|---|---|---|
| `write_memory` | Ingests a fact, preference, or note as raw source material for the long-term memory wiki, optionally under a wiki folder. | Pure DB write plus a queued wiki-maintenance job in SQLite mode. |
| `search_memory` | Searches the long-term memory wiki first, with raw source rows as fallback while wiki maintenance is pending. | None — pure read. |
| `wiki_search` / `_read` / `_list` / `_maintain` | Search/read/list synthesized SQLite wiki pages and drain queued memory-to-wiki maintenance jobs. | Model maintenance writes only through typed store methods; raw memories are never auto-deleted. |
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

### Security mode

`MINICLAW_SECURITY_MODE` accepts `off`, `medium`, or `high`. `off` is the default and disables only the extra LLM policy gate; hardcoded skill sandboxes, schemas, allowlists, and per-skill confirmations still apply. `medium` is reserved for stricter built-in policy and currently has the same extra gate behavior as `off`. `high` adds a small-LLM gate before every tool call; it sends the original user request plus the proposed tool name/args to the configured small model and denies calls that are unsafe or do not match the original intent. `high` requires `MINICLAW_SMALL_PROVIDER` and fails closed if the policy check cannot produce a valid allow/deny decision.

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
| `MINICLAW_SMALL_PROVIDER` | Optional small-task provider for compaction, dreaming, wiki maintenance, and high-security tool gating. | — |
| `MINICLAW_SMALL_MODEL` | Override the small provider's default model. | provider default |
| `MINICLAW_SMALL_API_KEY` | Explicit API key for the small provider. | provider key env |
| `MINICLAW_SMALL_API_KEY_VAR` | Env var name to read for the small provider's API key. | provider default |
| `MINICLAW_SMALL_BASE_URL` | OpenAI-compatible endpoint for the small provider. | `MINICLAW_BASE_URL` for OpenAI |
| `MINICLAW_SECURITY_MODE` | `off` \| `medium` \| `high`. High uses the small LLM to approve every tool call against the original user request. | `off` |
| `MINICLAW_WIKI_BROWSER` | `on` or `off`. Starts the local token-authenticated wiki browser for long-running SQLite sessions. | `on` |
| `MINICLAW_WIKI_BROWSER_HOST` | Host/interface for the wiki browser. Keep this loopback unless you provide network-level controls. | `127.0.0.1` |
| `MINICLAW_WIKI_BROWSER_PORT` | Port for the wiki browser. `0` asks the OS for a random available port. | `0` |
| `MINICLAW_WIKI_BROWSER_TOKEN` | Optional fixed token for the wiki browser. If unset, a random token is generated each run. | random |
| `MINICLAW_HOME` | Data directory for SQLite, daemon socket, PID file, daemon logs. | `~/.miniclaw` |
| `MINICLAW_WORKSPACE` | Filesystem sandbox root for `read_file`, `list_directory`, `write_file`, `apply_patch`, `shell`, `browser_screenshot`. Also where `AGENTS.md`/`TOOLS.md` are looked up. | `process.cwd()` |
| `MINICLAW_SOCKET` | Override the daemon's Unix socket path. | `$MINICLAW_HOME/miniclaw.sock` |
| `MINICLAW_PID` | Override the daemon's PID file path. | `$MINICLAW_HOME/miniclaw.pid` |
| `MINICLAW_WEB_ALLOWLIST` | Comma-separated origins `fetch_url` is allowed to call. Unset = no allowlist (any URL). | — |
| `MINICLAW_SEARCH_API_KEY` | Enables the `web_search` skill (Brave / Tavily / etc., depending on `MINICLAW_SEARCH_PROVIDER`). | — |
| `MINICLAW_SEARCH_PROVIDER` | Which search backend to use when the search skill is enabled. | provider default |
| `MINICLAW_DISCORD_TOKEN` | Bot token. If set, the daemon starts the Discord transport on `daemon run`. | — |

`install launchd|systemd` forwards exactly the variables above into the generated service file; everything else in your shell environment stays out of the service environment.
