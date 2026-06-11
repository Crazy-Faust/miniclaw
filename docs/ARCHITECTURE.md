# Miniclaw Architecture

This document maps the current codebase at a package and runtime-flow level.

## Package Layers

```mermaid
flowchart TB
  core["@miniclaw/core<br/>interfaces and shared types"]

  agent["@miniclaw/agent<br/>tool loop and audit dispatch"]
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
  participant Registry as SkillRegistry
  participant Skill
  participant Store as Memory/Conversation/Audit Store

  User->>Harness: message
  Harness->>Agent: runTurn(message, hooks)
  Agent->>Context: recordUser(message)
  Context->>Store: logTurn(user)
  Agent->>Context: prepare(message)
  Context->>Store: recentMessages + memory.search
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
  store["SqliteStore<br/>sessions, conversations, audit, cron, allowlist"]
  agentFactory["agentFor(session)<br/>per-session ContextManager in daemon"]
  agent["Agent"]

  chat --> daemon
  daemon --> gateway
  discord --> gateway
  scheduler --> gateway
  gateway --> store
  gateway --> agentFactory
  agentFactory --> agent
  agent --> store
```

Notes:

- In daemon mode, `agentFor(session)` creates a `WindowedContextManager` bound to the session conversation id.
- In REPL mode, `sessions_*` skills currently use a gateway whose `agentFor` returns the same CLI agent/context for all sessions, so session isolation is weaker there than in daemon mode.
- The daemon starts `CronScheduler`, but the current daemon skill registry only adds `sessions_*`; it imports but does not register `cron_*` or `canvas_*`.

## Skill Safety Gates

```mermaid
flowchart TB
  model["Model tool call"]
  zod["Zod parameter validation"]
  prehook["Optional pre-tool hook<br/>can veto or rewrite args"]
  confirm["User confirmation<br/>requiresConfirmation skills"]
  exec["Skill execution"]
  audit["Audit log"]
  result["Tool result to model"]

  model --> prehook
  prehook --> zod
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
