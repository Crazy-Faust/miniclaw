# Refactor: Unify entry points behind an auto-started daemon

**Status:** proposed · **Owner:** _tbd_ · **Estimated effort:** ~3–4 days (Phase 1 / MVP) → ~1.5–2.5 weeks (full parity)

## 1. Goal

Today miniclaw has three ways to start the agent and they behave differently
(see §2). The goal is one workflow:

> **However a session is started, ensure a gateway daemon is running (spawn one
> if absent, connect to it if present), then attach as a client.** Per-session
> memory stays isolated. Agent functionality (cron, transports, wiki worker) is
> always available because there is always a daemon.

The key enabler already exists: the daemon (`runForeground` in
[daemon.ts](../packages/cli/src/daemon.ts)) already builds **per-session agents
over a Unix socket**, and `miniclaw chat` ([chat.ts](../packages/cli/src/chat.ts))
already attaches. This refactor is **glue + closing feature gaps**, not new
subsystems.

## 2. Current state (the problem)

Two near-duplicate agent-construction sites drift independently:

| | `runAgent()` — [main.ts:100](../packages/cli/src/main.ts) | `runForeground()` — [daemon.ts:104](../packages/cli/src/daemon.ts) |
|---|---|---|
| Serves | `repl`, `one-shot` | `daemon run` (chat attaches) |
| Agent | **one** in-process agent (`agentFor: () => agent`) | **fresh per session** (`agentFor: (session) => new Agent`) |
| Transport | readline `Harness`, in-process | Unix socket (`startSocketDaemon`) |
| Cron / Discord | ❌ none | ✅ active |
| Slash commands | **9** (full set) | **4** over the wire |
| Tool confirmation | ✅ `confirmTool` wired | ❌ not passed to per-session agent |
| `--stateless` / `--ephemeral` | ✅ only here | ❌ n/a |
| Store | Sqlite **or** InMemory | Sqlite only |

Per-session memory isolation is **already solved** in the gateway —
`attach(channel)` creates one conversation per channel
([gateway.ts:44](../packages/gateway/src/gateway.ts)).

## 3. Target architecture

```
miniclaw                 ─┐
miniclaw "prompt"         ├─► ensureDaemon() ─► socketAttachIO(...)  ─► [daemon]
miniclaw chat [--channel] ─┘        │                                     │
                                    │ spawn `daemon run` if no live socket │
miniclaw --ephemeral / --stateless ───────────────────────────────► in-process bypass (no daemon)
miniclaw daemon run|start|stop|status   (unchanged)
miniclaw install launchd|systemd        (unchanged)
```

- `runForeground()` (the daemon) becomes the **single** agent-construction site
  for normal use.
- `repl`, `one-shot`, `chat` all become **clients** of it.
- `--ephemeral` / `--stateless` are the **only** path that stays in-process
  (a deliberately reduced "throwaway" mode — see Decision D2).

## 4. Decisions taken

These were open questions in the estimate. Defaults chosen below; **override any
of them and the affected steps change.**

**D1 — Daemon lifecycle: leave it running.**
An auto-started daemon persists after the client detaches (this *is* "always
have agent functionality"). It is stopped only by `miniclaw daemon stop` or a
service manager. No reference-counting / auto-stop in scope.
_Alternative:_ ref-count clients and auto-stop the auto-started daemon when the
last detaches (grows Step 1.1).

**D2 — `--ephemeral` / `--stateless`: keep as an in-process bypass.**
Neither maps onto a shared persistent daemon (the daemon owns one `SqliteStore`
and builds `CompactingContextManager` per session). They remain the single
in-process path, with **reduced** functionality (no cron/transports) — which is
the point of a throwaway agent. Lowest risk, preserves existing tests.
_Alternative:_ drop the flags entirely, or teach the daemon ephemeral sessions
(bigger protocol + gateway change).

**D3 — Config is read once, at daemon boot.**
A running daemon's provider/model/security wins; a later client started with
different env is ignored. Today each REPL reads its own env, so this is a
behavior change — document it. Per-session model override is **out of scope**
(would need a protocol field + per-session LLM construction).

**D4 — Per-launch session identity (memory isolation).**
`repl` and `one-shot` default to a **fresh** session per launch (preserves
today's "new conversation each start"); `chat` **resumes** the channel's active
session (today's behavior). Both accept `--channel <name>`; add `--resume` to
attach instead of spawn. Implemented via a `fresh` flag on the `attach` protocol
message (Step 1.4).

## 5. Target socket protocol

Several steps extend the JSON-Lines protocol in
[gateway/src/daemon.ts](../packages/gateway/src/daemon.ts) (server) and
[gateway/src/attach.ts](../packages/gateway/src/attach.ts) (client). Define the
full target up front so steps stay consistent. **Bold = new.**

**Client → server**

| Message | Meaning |
|---|---|
| `{ type: "attach", channel, `**`fresh?`**` }` | find-or-create (or **spawn fresh** when `fresh:true`) the session for `channel` |
| `{ type: "user", text }` | run one agent turn |
| `{ type: "status" \| "usage" \| "wiki_maintain" \| "dream" }` | control commands |
| **`{ type: "skills" }`** | list registered tools + SKILL.md skills |
| **`{ type: "memories", n? }`** | list recent memories |
| **`{ type: "reset" }`** | end current session, spawn a fresh one on same channel |
| **`{ type: "confirm_reply", id, approved }`** | answer a confirmation request |
| `{ type: "end" }` | end session + disconnect |

**Server → client**

| Message | Meaning |
|---|---|
| `{ type: "attached", sessionId, channel }` | attach acknowledged |
| `{ type: "token", delta }` | streamed assistant text |
| `{ type: "tool", name, args }` / `{ type: "tool_result", ... }` | tool activity |
| `{ type: "final", text }` / `{ type: "error", message }` | turn end |
| `{ type: "status" \| "usage" \| "wiki_maintain" \| "dream", ... }` | control replies |
| **`{ type: "skills", tools: [...], skills: [...] }`** | skills reply |
| **`{ type: "memories", rows: [...] }`** | memories reply |
| **`{ type: "reset", sessionId }`** | new session id after reset |
| **`{ type: "confirm", id, name, args, description }`** | ask client to confirm a sensitive tool call |

---

# Phase 1 — Core: auto-start + connect (MVP, ~3–4 days)

Delivers the literal ask. `runForeground` is untouched; `runAgent` survives only
behind `--ephemeral`/`--stateless`.

## Step 1.1 — `ensureDaemon()` helper

**New file:** `packages/cli/src/ensure-daemon.ts`. Reuses pid/socket helpers
from `@miniclaw/gateway` ([paths.ts](../packages/gateway/src/paths.ts)) and the
spawn pattern already in [daemon.ts:89](../packages/cli/src/daemon.ts).

Responsibilities, in order:
1. `loadConfig()` **in the parent** first — a missing API key fails fast in the
   foreground with the existing clear error, instead of a silently-crashing
   detached child.
2. If pid is alive **and** the socket accepts a connection → reuse, return.
3. Otherwise spawn `daemon run` detached — but **redirect child stdio to log
   files** in `$MINICLAW_HOME` (`daemon.out.log` / `daemon.err.log`), *not*
   `"ignore"`, so boot failures are diagnosable.
4. Poll-connect to the socket up to ~10s. On success → return. On timeout →
   print the tail of `daemon.err.log` and exit non-zero.

```ts
// sketch — packages/cli/src/ensure-daemon.ts
import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSocketPath, defaultPidPath, readPid } from "@miniclaw/gateway";
import { loadConfig } from "./config.ts";

const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");

export async function ensureDaemon(): Promise<string> {
  loadConfig();                                  // (1) fail fast on bad config
  const socketPath = defaultSocketPath();
  const pid = readPid(defaultPidPath());
  if (pid && isAlive(pid) && (await canConnect(socketPath))) return socketPath; // (2)

  const home = process.env.MINICLAW_HOME ?? join(homedir(), ".miniclaw");
  const out = openSync(join(home, "daemon.out.log"), "a");
  const err = openSync(join(home, "daemon.err.log"), "a");
  const child = spawn(process.execPath, [...process.execArgv, ENTRY, "daemon", "run"], {
    detached: true, stdio: ["ignore", out, err], env: process.env,        // (3)
  });
  child.unref();

  if (await waitForSocket(socketPath, 10_000)) return socketPath;          // (4)
  const tail = safeTail(join(home, "daemon.err.log"), 20);
  process.stderr.write(`daemon failed to start within 10s.\n${tail}\n`);
  process.exit(1);
}
// canConnect/waitForSocket: createConnection + once("connect")/once("error"),
// retry every ~150ms. isAlive: process.kill(pid, 0). (mirror daemon.ts:290)
```

**Tests:** `packages/cli/tests/ensure-daemon.test.ts` — (a) returns immediately
when a fake socket server is already listening; (b) spawns and resolves when the
socket appears; (c) times out + surfaces the err-log tail. Use a temp
`MINICLAW_HOME` + `MINICLAW_SOCKET`.

**Concurrency note:** two simultaneous launches can both attempt a spawn; the
loser's daemon hits `EADDRINUSE` on `server.listen` and exits, while the
winner's socket comes up and both clients attach. Acceptable; optional hardening
is an advisory lockfile in `$MINICLAW_HOME`.

## Step 1.2 — Route `repl` and `chat` through attach

**Edit:** [main.ts](../packages/cli/src/main.ts) dispatch. `repl` no longer
calls `runAgent` (except the bypass, Step 1.5); both `repl` and `chat` become
`ensureDaemon()` + `socketAttachIO()`.

```ts
// main.ts — switch(mode.kind)
case "repl":
  if (mode.stateless || mode.ephemeral) { await runAgent(mode, loadConfig()); return; } // D2 bypass
  await runClient({ channel: mode.channel ?? "cli", fresh: !mode.resume }); return;
case "chat":
  await runClient({ channel: mode.channel, fresh: false }); return;       // resume
```

`runChat` in [chat.ts](../packages/cli/src/chat.ts) currently **errors if no
daemon** — replace that early-exit with `ensureDaemon()`. Fold `chat.ts` into a
shared `runClient({ channel, fresh, oneShot? })` that both modes call.

## Step 1.3 — One-shot over the socket

**Edit:** [gateway/src/attach.ts](../packages/gateway/src/attach.ts) — add a
non-interactive mode to `socketAttachIO`:

```ts
export interface SocketAttachOpts {
  socketPath: string; channel: string; banner?: string;
  fresh?: boolean;          // Step 1.4
  oneShot?: string;         // Step 1.3 — send once, print final, detach
}
```

When `oneShot` is set: after `attached`, send one `{type:"user", text:oneShot}`,
await `final`/`error`, then send `{type:"end"}` and resolve — no readline loop.
The daemon keeps running (D1). `miniclaw "prompt"` → `ensureDaemon()` +
`runClient({ channel: "cli", fresh: true, oneShot: prompt })`.

> Behavior change to note in docs: one-shot now leaves a daemon running and its
> memory IS wiki-maintained by the daemon worker (previously one-shot ran no
> worker). This is more consistent, not less.

## Step 1.4 — `fresh` flag on attach (session identity, D4)

**Edit:** [gateway/src/daemon.ts](../packages/gateway/src/daemon.ts) `dispatch`,
`attach` case:

```ts
if (type === "attach") {
  const ch = String(msg.channel ?? "");
  if (!ch) { send({ type: "error", message: "attach requires 'channel'" }); return; }
  channel = ch;
  session = msg.fresh ? gateway.spawn(channel) : gateway.attach(channel);  // spawn vs find-or-create
  send({ type: "attached", sessionId: session.record.id, channel });
  return;
}
```

`gateway.spawn` ([gateway.ts:64](../packages/gateway/src/gateway.ts)) already
ends any active session on the channel and starts a clean one. Client passes
`fresh` from `SocketAttachOpts` in the initial attach write
([attach.ts:32](../packages/gateway/src/attach.ts)).

**Argv:** add `--channel` to `repl`/`one-shot` and a `--resume` flag.
Extend `Mode` in [argv.ts](../packages/cli/src/argv.ts):
`repl`/`one-shot` gain `channel?: string; resume: boolean`.

## Step 1.5 — Gate the in-process path behind the flags (D2)

`runAgent` in [main.ts](../packages/cli/src/main.ts) stays, reachable **only**
when `--ephemeral` or `--stateless` is set. Add a one-line banner so it's
obvious you're off the daemon: `"(in-process mode — no daemon, cron/transports
unavailable)"`. No other change in Phase 1.

### Phase 1 acceptance

- `miniclaw` with no daemon running → spawns one, attaches, REPL works; daemon
  survives `/exit`.
- Second `miniclaw` → attaches to the same daemon (no second spawn).
- `miniclaw "2+2"` → answers, exits, daemon still up (`miniclaw daemon status`).
- `miniclaw chat` → resumes; `miniclaw` (repl) → fresh session.
- `miniclaw --ephemeral` → in-process, no socket touched.
- Bad/missing API key → clear foreground error, no zombie daemon.

---

# Phase 2 — Parity (~2.5–5 days)

So the unified path doesn't regress vs the old in-process REPL.

## Step 2.1 — Extract a shared agent-stack builder (kills the duplication)

**New file:** `packages/cli/src/agent-stack.ts`. Move the common wiring out of
`runForeground` (and the bypass) into one function:

```ts
export interface AgentStack {
  gateway: Gateway; registry: SkillRegistry; controls: SocketDaemonControls;
  wikiWorker?: MemoryWikiWorker; wikiBrowser?: WikiBrowserHandle;
  agentSkillList: AgentSkillSummary[]; close(): Promise<void>;
}
export function buildAgentStack(config: Config, store: SqliteStore | InMemoryStore,
  opts: { oneShot?: boolean }): AgentStack { /* llm, smallLLM, toolGuard,
  loadSkills, wikiMaintainer/worker/browser, Gateway w/ per-session agentFor,
  register sessions+cron+wiki+dream skills, dreamer, controls */ }
```

- `runForeground` ([daemon.ts:104](../packages/cli/src/daemon.ts)) calls it,
  then adds **only** the daemon-specific parts: transports, `CronScheduler`,
  `startSocketDaemon`, signal handlers.
- The `--ephemeral`/`--stateless` bypass calls it too, then runs the in-process
  `Harness` with the full `metaCommands` (so throwaway mode keeps all 9 slash
  commands locally).
- The old default in-process Gateway/single-agent/controls block in
  `runAgent` ([main.ts:188-241](../packages/cli/src/main.ts)) is **deleted** —
  this is the payoff (net negative LOC; ends the drift documented in
  [ARCHITECTURE.md](ARCHITECTURE.md) "session isolation is weaker there").

The per-session `agentFor` in the shared builder is the daemon's existing one
([daemon.ts:148](../packages/cli/src/daemon.ts)) — wired with `confirmTool` in
Step 2.3.

## Step 2.2 — Slash-command parity over the socket

The in-process Harness exposes `/skills /memories /reset /dream /wiki_maintain
/status /usage /make_skill /help`; the socket supports only 4. Add the rest.

- **`/skills`** — new `controls.skills()` returns `{ tools, skills }`; server
  handles `{type:"skills"}` → `{type:"skills", tools, skills}`; client renders
  (port the formatting from `skillsCommand` in
  [harness/src/meta.ts:60](../packages/harness/src/meta.ts)).
- **`/memories [N]`** — new `controls.memories(n)`; server `{type:"memories"}`;
  client renders (port `memoriesCommand`,
  [meta.ts:302](../packages/harness/src/meta.ts)).
- **`/reset`** — server `{type:"reset"}` → `gateway.end(session.id)` then
  `session = gateway.spawn(channel)` → reply `{type:"reset", sessionId}`.
- **`/help`** — keep **client-side** (static list of socket commands).
- **`/make_skill`** — keep **client-side**. It is an interactive scaffolding
  wizard that writes files into the local workspace
  ([make-skill/](../packages/cli/src/make-skill/)); for the local socket the
  client shares host + workspace, so running it in-client is correct and avoids
  streaming a multi-prompt wizard over the wire. Wire it into the attach loop's
  command switch ([attach.ts:155](../packages/gateway/src/attach.ts)).

Extend `SocketDaemonControls`
([gateway/src/daemon.ts:6](../packages/gateway/src/daemon.ts)) with
`skills()` and `memories(n)`; the builder (Step 2.1) supplies them from the
registry + store.

## Step 2.3 — Tool confirmation over the socket

Real gap: the daemon's per-session agent never receives `confirmTool`, so any
skill with `requiresConfirmation` **fails closed** remotely
([agent.ts:318](../packages/agent/src/agent.ts)). Make confirmation a per-turn
hook so the socket can answer it.

**(a) Agent** — add to `AgentTurnHooks`
([agent.ts:88](../packages/agent/src/agent.ts)):
```ts
onConfirmTool?(call: { name: string; args: unknown },
  skill: { name: string; description: string }): Promise<boolean>;
```
In `executeOne`, prefer the hook over the dep:
```ts
const confirm = hooks?.onConfirmTool ?? this.deps.confirmTool;   // agent.ts:319
```

**(b) Server** — in `handleClient` keep a `Map<string,{resolve}>` of pending
confirms. In the `user` turn hooks, add:
```ts
onConfirmTool: (call, skill) => new Promise<boolean>((resolve) => {
  const id = randomUUID();
  pending.set(id, resolve);
  send({ type: "confirm", id, name: call.name, args: call.args, description: skill.description });
}),
```
Handle `{type:"confirm_reply", id, approved}` in `dispatch` → resolve + delete.

**(c) Client** — in `handleEvent` ([attach.ts:59](../packages/gateway/src/attach.ts))
add a `confirm` case that prompts (`rl.question` is free — the outer loop is
awaiting the turn waiter) and writes `confirm_reply`. Tool calls run
sequentially, so confirms arrive one at a time.

**Tests:** gateway test with a fake skill requiring confirmation; assert the
`confirm` event is emitted and `confirm_reply:false` yields a denied tool result.

### Phase 2 acceptance

- Every slash command available in the old REPL works over the socket (or is
  intentionally client-side: `/help`, `/make_skill`).
- A `requiresConfirmation` skill prompts the attached client and honors y/N.
- `runAgent`'s default in-process gateway block is gone; `runForeground` and the
  bypass share `buildAgentStack`.

---

# Phase 3 — Cleanup, tests, docs (~1–1.5 days)

## Step 3.1 — Tests
- `ensure-daemon.test.ts` (Step 1.1).
- Extend [gateway/tests](../packages/gateway/tests/) for `attach{fresh}`,
  `skills`, `memories`, `reset`, and the `confirm`/`confirm_reply` round-trip.
- Update [wiring.test.ts](../packages/cli/tests/wiring.test.ts) if the skill
  registration path moves into `buildAgentStack`.
- Integration smoke (fake LLM): `ensureDaemon` → attach → one `user` turn →
  `final`. Can live in `packages/cli/tests`.

## Step 3.2 — Docs
- **README** — rewrite the prominent "You can use miniclaw three ways" section
  ([README.md](../README.md)) to "one way: a daemon you attach to," with the
  `--ephemeral`/`--stateless` bypass and `daemon start|stop|status` as the
  control surface. Update the "First run" expected output.
- **ARCHITECTURE.md** — update the "Daemon And Transports" notes; delete the
  "session isolation is weaker in REPL mode" caveat (no longer true).
- **ROADMAP.md** — tick Phase 1 exit criteria; note auto-start landed.
- **MANUAL_TESTS.md** — adjust section A (REPL no longer in-process) and add an
  auto-start case.

## Step 3.3 — Remove dead code
- Whatever in `runAgent` / `cli/src/io.ts` is unused once the bypass is the only
  in-process consumer (e.g. `createReadlineIO` may still be needed by the
  bypass; `createOneShotIO` likely removable — one-shot now goes over the
  socket). Confirm with `tsc --noEmit` + `knip`/grep before deleting.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Detached daemon crashes silently on boot (bad key, port in use) | Parent `loadConfig()` pre-flight; child stdio → log files; print err-log tail on socket timeout (Step 1.1) |
| Spawn race between two launches | Poll-connect tolerates losing the race; optional lockfile |
| Confirm round-trip deadlock if client ignores `confirm` | Client always answers; optional server-side timeout → treat as deny (fail closed) |
| Config drift (D3) — stale model in long-lived daemon | Document; `daemon stop` to pick up new env; per-session override is a later feature |
| `/make_skill` over a *remote* socket writes to the daemon host, not the user | Keep client-side for local socket; revisit if/when a remote transport needs it |
| Concurrent REPLs share one daemon's rate limits / wiki worker | Expected with a shared daemon; `--channel` isolates conversations, not resources |

## 7. Rollout / rollback

- Land **Phase 1** behind nothing — it's additive (daemon path already exists);
  if auto-start misbehaves, `runAgent` still works via `--ephemeral`.
- Each phase is independently shippable and reversible (git revert of the
  phase's commits). Phase 2's `buildAgentStack` extraction is the only one that
  rewrites existing files heavily — do it as its own commit with green tests
  before/after.

## 8. Master checklist

**Phase 1 (MVP)**
- [ ] `ensure-daemon.ts` + tests (Step 1.1)
- [ ] `repl`/`chat` → `ensureDaemon` + `socketAttachIO`; fold `chat.ts` into `runClient` (1.2)
- [ ] one-shot mode in `socketAttachIO` (1.3)
- [ ] `fresh` flag on `attach` (server + client + argv `--channel`/`--resume`) (1.4)
- [ ] gate `runAgent` behind `--ephemeral`/`--stateless` + banner (1.5)
- [ ] Phase 1 acceptance pass

**Phase 2 (parity)**
- [ ] `buildAgentStack` extracted; `runForeground` + bypass use it; default in-process gateway deleted (2.1)
- [ ] `/skills`, `/memories`, `/reset` over socket; `/help`, `/make_skill` client-side (2.2)
- [ ] `onConfirmTool` hook + socket `confirm`/`confirm_reply` (2.3)
- [ ] Phase 2 acceptance pass

**Phase 3 (cleanup)**
- [ ] tests updated/added (3.1)
- [ ] README / ARCHITECTURE / ROADMAP / MANUAL_TESTS updated (3.2)
- [ ] dead code removed; `pnpm test` + `pnpm typecheck` green (3.3)
