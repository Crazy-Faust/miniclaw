# Miniclaw Architecture

This document maps the current codebase at a package and runtime-flow level.

## Package Layers

```mermaid
flowchart TB
  core["@miniclaw/core<br/>interfaces and shared types"]

  agent["@miniclaw/agent<br/>tool loop, audit dispatch, tool security gate"]
  dreaming["@miniclaw/dreaming<br/>background reflection"]
  harness["@miniclaw/harness<br/>REPL/meta-command orchestration"]
  gateway["@miniclaw/gateway<br/>sessions, daemon socket, cron runner"]
  http["@miniclaw/io-http<br/>HTTP + SSE wrapper"]
  cli["@miniclaw/cli<br/>composition root"]

  contextStateless["@miniclaw/context-stateless"]
  contextWindowed["@miniclaw/context-windowed"]

  llmAnthropic["@miniclaw/llm-anthropic"]
  llmOpenAI["@miniclaw/llm-openai"]
  llmGemini["@miniclaw/llm-gemini"]

  memorySqlite["@miniclaw/memory-sqlite<br/>SQLite persistence"]
  memoryInmemory["@miniclaw/memory-inmemory"]
  memoryVector["@miniclaw/memory-vector"]
  memoryWiki["@miniclaw/memory-wiki<br/>SQLite LLM wiki maintainer"]
  wikiBrowser["@miniclaw/memory-wiki<br/>local wiki browser"]

  skillsFs["@miniclaw/skills-fs"]
  skillsShell["@miniclaw/skills-shell"]
  skillsDb["@miniclaw/skills-db"]
  skillsMemory["@miniclaw/skills-memory"]
  skillsWeb["@miniclaw/skills-web"]
  skillsBrowser["@miniclaw/skills-browser"]
  skillsCron["@miniclaw/skills-cron"]
  skillsSessions["@miniclaw/skills-sessions"]
  skillsCanvas["@miniclaw/skills-canvas"]
  skillsTodo["@miniclaw/skills-todo"]

  discord["@miniclaw/transport-discord"]

  agent --> core
  dreaming --> agent
  dreaming --> core
  harness --> agent
  harness --> core
  gateway --> agent
  gateway --> core
  http --> agent
  http --> core

  contextStateless --> core
  contextWindowed --> core
  llmAnthropic --> core
  llmOpenAI --> core
  llmGemini --> core
  memorySqlite --> core
  memoryInmemory --> core
  memoryVector --> core
  memoryWiki --> core
  wikiBrowser --> core

  skillsFs --> core
  skillsShell --> core
  skillsDb --> core
  skillsMemory --> core
  skillsWeb --> core
  skillsBrowser --> core
  skillsCanvas --> core
  skillsTodo --> core
  skillsCron --> core
  skillsCron --> gateway
  skillsSessions --> core
  skillsSessions --> gateway

  discord --> core
  discord --> gateway

  cli --> agent
  cli --> dreaming
  cli --> harness
  cli --> gateway
  cli --> contextStateless
  cli --> contextWindowed
  cli --> llmAnthropic
  cli --> llmOpenAI
  cli --> llmGemini
  cli --> memorySqlite
  cli --> memoryInmemory
  cli --> memoryWiki
  cli --> skillsFs
  cli --> skillsShell
  cli --> skillsDb
  cli --> skillsMemory
  cli --> skillsWeb
  cli --> skillsCron
  cli --> skillsSessions
  cli --> skillsCanvas
  cli --> discord
```

## Interactive Turn Flow

```mermaid
sequenceDiagram
  autonumber
  participant User
  participant Harness as Harness or Socket/HTTP Adapter
  participant Agent
  participant Context as ContextManager
  participant LLM as LLMProvider
  participant Guard as Optional Small-LLM Tool Guard
  participant Registry as SkillRegistry
  participant Skill
  participant Store as Memory/Conversation/Audit Store

  User->>Harness: message
  Harness->>Agent: runTurn(message, hooks)
  Agent->>Context: recordUser(message)
  Context->>Store: logTurn(user)
  Agent->>Context: prepare(message)
  Context->>Store: recentMessages + knowledge.searchKnowledge (wiki-first) or memory.search fallback
  Context-->>Agent: system prompt + messages
  Agent->>LLM: chat(system, messages, tools)
  alt final answer
    LLM-->>Agent: final text
    Agent->>Context: recordAssistant(text)
    Context->>Store: logTurn(assistant)
    Agent-->>Harness: TurnTrace
    Harness-->>User: final text
  else tool use
    LLM-->>Agent: tool calls
    Agent->>Registry: get skill
    opt MINICLAW_SECURITY_MODE=high
      Agent->>Guard: original user request + tool name/args
      Guard-->>Agent: allow or deny
    end
    Agent->>Agent: Zod validate proposed args
    Agent->>Harness: optional confirmation for sensitive skill
    Agent->>Skill: execute(args, SkillContext)
    Skill-->>Agent: SkillResult
    Agent->>Store: audit.logToolCall
    Agent->>LLM: chat(..., tool result)
  end
```

## Daemon And Transports

```mermaid
flowchart LR
  chat["miniclaw chat<br/>Unix socket client"]
  discord["Discord DM transport<br/>pairing + allowlist"]
  daemon["Socket daemon<br/>JSON-lines protocol"]
  gateway["Gateway<br/>attach/spawn/list/history/end"]
  scheduler["CronScheduler<br/>polls cron_jobs"]
  cronSession["isolated cron session<br/>cron:&lt;job&gt;:&lt;time&gt;"]
  store["SqliteStore<br/>sessions, conversations, audit, cron, allowlist"]
  agentFactory["agentFor(session)<br/>per-session ContextManager in daemon"]
  agent["Agent"]

  chat --> daemon
  daemon --> gateway
  discord --> gateway
  scheduler --> gateway
  scheduler --> cronSession
  cronSession --> gateway
  gateway --> store
  gateway --> agentFactory
  agentFactory --> agent
  agent --> store
```

Notes:

- In daemon mode, `agentFor(session)` creates a `CompactingContextManager` bound to the session conversation id.
- In REPL mode, `sessions_*` skills currently use a gateway whose `agentFor` returns the same CLI agent/context for all sessions, so session isolation is weaker there than in daemon mode.
- REPL and daemon both register sessions, cron, canvas, wiki, and dream skills after their runtime stores/runners exist.
- Cron jobs deliver results back to their originating channel, but each job execution runs in a fresh ended `cron:<job-id>:<timestamp>` session. This prevents scheduled jobs from inheriting or extending a large Discord/CLI conversation context.

## Long-Term Memory Wiki

```mermaid
flowchart TB
  write["write_memory<br/>raw source ingest"]
  sqlite["SqliteStore.add<br/>memories + memory_metadata"]
  queue["memory_maintenance_jobs<br/>memory_write"]
  worker["MemoryWikiWorker<br/>only auto-starts with small LLM"]
  maintainer["MemoryWikiMaintainer<br/>strict JSON action planner"]
  small["Small LLM<br/>or primary for manual wiki_maintain"]
  actions["Validated actions<br/>upsert_page, add_link, mark_memory, append_log"]
  wiki["wiki_folders + wiki_pages + wiki_links + wiki_log"]
  usage["llm_usage_events<br/>primary + small model usage"]
  usagePage["Protected LLM Usage page<br/>browser-only, hidden from LLM"]
  search["search_memory / context retrieval<br/>KnowledgeStore.searchKnowledge"]
  prompt["System prompt<br/>query-scoped memory index only"]
  browser["Local wiki browser<br/>token-authenticated localhost UI"]

  write --> sqlite
  sqlite --> queue
  queue --> worker
  queue --> maintainer
  worker --> maintainer
  maintainer --> small
  small --> actions
  actions --> sqlite
  sqlite --> wiki
  sqlite --> usage
  usage --> usagePage
  wiki --> search
  sqlite --> search
  search --> prompt
  wiki --> browser
  usagePage --> browser
```

Raw `memories` rows are immutable source history. The synthesized wiki is the long-term memory surface the agent reads from. `searchKnowledge()` prefers matching wiki pages; active raw source rows appear only as fallback index entries while no wiki page matches yet. Automatic context retrieval injects handles and metadata, not full memory content; the model must call `wiki_read` or `search_memory` before relying on a memory.

LLM usage statistics are user-facing system data, not long-term memory. SQLite records primary/small model call usage in `llm_usage_events`, including task attribution for user messages, cron jobs, compaction, wiki maintenance, dreaming, and tool-security checks. It renders a protected `system/llm-usage.md` browser page with totals by task, model role, channel/job, and recent call. Normal wiki read/list/search APIs hide that page, and model-generated maintenance actions cannot update or link it.

## Skill Safety Gates

```mermaid
flowchart TB
  model["Model tool call"]
  prehook["Optional pre-tool hook<br/>can veto or rewrite args"]
  llmguard["Tool security gate<br/>high mode asks small LLM<br/>off/medium pass through"]
  zod["Zod parameter validation"]
  confirm["User confirmation<br/>requiresConfirmation skills"]
  exec["Skill execution"]
  audit["Audit log"]
  result["Tool result to model"]

  model --> prehook
  prehook --> llmguard
  llmguard --> zod
  zod --> confirm
  confirm --> exec
  exec --> audit
  audit --> result

  fs["skills-fs<br/>workspace realpath checks<br/>size caps<br/>write/patch require confirmation"]
  shell["skills-shell<br/>binary allowlist<br/>argv spawn with shell=false<br/>path-like args checked lexically"]
  db["skills-db<br/>readonly SQLite handle<br/>SELECT/WITH guard<br/>row cap"]
  web["skills-web<br/>domain allowlist<br/>private host literal checks<br/>byte/time caps"]
  browser["skills-browser<br/>lazy Playwright driver<br/>interactive click/fill confirmation"]

  exec --> fs
  exec --> shell
  exec --> db
  exec --> web
  exec --> browser
```

## Persistence Schema Areas

```mermaid
erDiagram
  conversations ||--o{ messages : contains
  sessions }o--|| conversations : "conversation_id"
  memories ||--|| memories_fts : indexed_by
  memories ||--|| memory_metadata : annotated_by
  memories ||--o{ memory_maintenance_jobs : triggers
  wiki_folders ||--o{ wiki_pages : contains
  wiki_pages ||--|| wiki_pages_fts : indexed_by
  wiki_pages ||--o{ wiki_links : links
  wiki_pages ||--o{ wiki_log : described_by
  llm_usage_events ||--o{ wiki_pages : "renders protected usage page"
  memory_maintenance_jobs {
    integer id
    text type
    integer memory_id
    text status
    integer attempts
  }
  wiki_log {
    integer id
    integer ts
    text event_type
    text message
  }
  llm_usage_events {
    integer id
    integer ts
    text provider
    text model
    text role
    text kind
    text task_kind
    text task_name
    text channel
    text session_id
    integer conversation_id
    text component
    integer input_tokens
    integer output_tokens
  }
  cron_jobs {
    integer id
    text name
    text prompt
    text schedule
    integer next_run_at
    text status
  }
  audit_log {
    integer id
    integer ts
    text skill
    text args_json
    text result_summary
    integer ok
  }
  channel_allowlist {
    text channel
    integer created_at
  }
  pairing_codes {
    text code
    text channel
    integer expires_at
  }
```
