# miniclaw → openclaw roadmap

A staged plan to bring miniclaw toward the feature surface of [openclaw](https://github.com/openclaw/openclaw). Each phase is shippable on its own — earlier phases unlock later ones, but you can stop after any phase and still have a coherent product.

---

## Today: where miniclaw stands

| Area | Status |
|---|---|
| LLM providers | Anthropic, OpenAI (+ Ollama via baseURL), Gemini |
| Skills | `write_memory`, `search_memory`, `read_file`, `list_directory`, `shell`, `sql_query`, `todo`, `fetch_url`, `web_search` |
| Memory | SQLite (FTS5), in-memory, vector embeddings |
| Context | windowed + retrieval, stateless |
| IO | CLI REPL, one-shot, HTTP (with SSE) |
| Orchestration | `agent` + transport-agnostic `harness` |
| Persistence | `~/.miniclaw/miniclaw.db`, full audit log of every tool call |
| Sandbox | `MINICLAW_WORKSPACE` for fs+shell, shell allowlist, no-shell-interpolation, SQL read-only guard |
| Slash commands | `/help`, `/skills`, `/memories`, `/make_skill`, `/exit` |
| Extensibility | Per-skill confirmation, scaffolder for new skills |

## Gap inventory — what openclaw adds

| Bucket | Missing in miniclaw |
|---|---|
| Transports | WhatsApp, Telegram, Slack, Discord, iMessage, Matrix, Teams, WebChat, +15 more |
| Multi-agent | Long-running gateway daemon (launchd/systemd), session spawn/list/history/send, per-agent isolated workspaces |
| Visual | Live Canvas / A2UI, macOS menu bar app, iOS/Android companion apps |
| Voice | Wake-word, push-to-talk, TTS (ElevenLabs + system fallback) |
| Tools | `browser`, `canvas`, `nodes`, `cron`, `sessions`, Discord/Slack actions, Gmail Pub/Sub |
| Skill ecosystem | ClawHub registry, bundled/managed/workspace scoping, `SKILL.md` definitions |
| Sandbox backends | Docker, SSH, OpenShell (vs miniclaw's path-prefix guard) |
| DM security | Pairing codes, per-channel allowlist |
| Operator commands | `/status`, `/reset`, `/compact`, `/think`, `/verbose`, `/trace`, `/usage`, `/restart`, `/activation` |
| Prompt injection files | `AGENTS.md`, `SOUL.md`, `TOOLS.md`, per-skill `SKILL.md` |
| Deployment | docker-compose, Fly.io, Render configs; stable/beta/dev release channels |

---

## Phase 1 — Gateway daemon foundation (1–2 weeks)

Today the CLI exits after a turn; openclaw is a daemon. Everything below depends on this.

- [ ] **`packages/gateway`** — supervise sessions, dispatch events. Wraps `harness` with a session registry keyed by `(channelId, userId)`.
- [ ] **Session store** — extend `memory-sqlite` schema with `sessions(id, channel, agent, status, created_at)` + per-session history.
- [ ] **`sessions` skill** — `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`. Mirrors openclaw's first-class session tool.
- [ ] **Service install** — `launchd` plist + `systemd` user unit; `miniclaw daemon start|stop|status`.
- [ ] **Slash commands**: `/status`, `/reset`, `/compact`, `/usage` (token + cost computed from the existing audit log).

**Exit criteria:** `miniclaw daemon start` survives a logout; `miniclaw chat` attaches to an existing session over a local socket.

## Phase 2 — Tool parity for the daemon era (1–2 weeks)

- [x] **`cron` skill** (now a `SKILL.md` folder in `@miniclaw/agent-skills`) — register/list/cancel scheduled prompts. Persisted in SQLite; the gateway runs them.
- [x] **`browser` skill** (now in `@miniclaw/agent-skills`, gated on the optional `playwright` peer) — Playwright/CDP wrapper. Two tiers: read-only (`open`, `read_page`, `screenshot`) and interactive (`click`, `fill`). Sandbox a profile dir under `MINICLAW_WORKSPACE`.
- [x] **`canvas` skill** (now in `@miniclaw/agent-skills`) — server-rendered HTML scratchpad. Live A2UI is Phase 6.
- [ ] **Prompt injection files** — `AGENTS.md` + `TOOLS.md` loaded by `context-windowed` into the system prompt. Skip `SOUL.md` until persona is a real ask.

**Exit criteria:** the agent can schedule a cron job that opens a URL, screenshots it, and writes a note to memory.

## Phase 3 — First external transport (1 week, then 1 per channel)

Pick one transport to prove the `IOAdapter` abstraction holds; subsequent channels become cheap.

- [ ] **`packages/io-telegram`** (recommended first — simplest bot API, free) implementing `IOAdapter`. Each chat → one session.
- [ ] **Pairing flow** — unknown sender gets a pairing-code DM; allowlist persisted in the gateway DB.
- [ ] **`packages/io-discord`**, **`packages/io-slack`**, **`packages/io-webchat`** — repeat the pattern once stable.

**Exit criteria:** sending a Telegram DM produces a tool-using reply in under 5s; an unknown sender is challenged for a pairing code.

## Phase 4 — Containerized sandboxing (1 week)

- [ ] **`Sandbox` interface** in `@miniclaw/core`; current path-prefix guard becomes the `local` impl.
- [ ] **`packages/sandbox-docker`** — runs `shell` and `browser` inside an ephemeral container, workspace bind-mounted RO/RW per skill.
- [ ] **`MINICLAW_SANDBOX=docker|local|ssh`** env var; default stays `local`.

**Exit criteria:** `MINICLAW_SANDBOX=docker pnpm dev` makes `shell` execute inside a container with no host write access outside the workspace.



---

## Out of scope

Features in openclaw that distort miniclaw's "small, local-first" architecture and are intentionally deferred:

- 23-channel integration matrix → ship 1–2 transports max; document `IOAdapter` for the rest.
- Multi-tenant managed agents (the `openclaw-managed-agents` flavor).
- Mobile apps, if the macOS companion already covers daily use.

## Sources

- [openclaw/openclaw on GitHub](https://github.com/openclaw/openclaw)
- [openclaw model providers docs](https://github.com/openclaw/openclaw/blob/main/docs/concepts/model-providers.md)
- [OpenClaw vs Claude Code (eigent.ai)](https://www.eigent.ai/blog/openclaw-vs-claude-code)
