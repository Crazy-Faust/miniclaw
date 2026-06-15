---
name: memory
description: Store durable facts and preferences into, and search, miniclaw's long-term memory wiki. Use when the user shares something to remember for future sessions, or asks you to recall something from earlier. Provides the write_memory and search_memory tools.
license: MIT
metadata:
  origin: miniclaw-builtin
---

# Memory

Long-term memory backed by the configured store (a wiki-aware SQLite store in
the default setup).

## Tools

- **`write_memory`** — ingest a fact, preference, note, or task the user will
  likely want recalled later. Optionally tag it and place it in a wiki folder
  (e.g. `inbox`, `research/papers`, `personal/goals`).
- **`search_memory`** — natural-language search. Wiki-aware stores return
  synthesized wiki pages first and raw source memories only as a fallback while
  maintenance is pending.

## How to use

1. When the user tells you something durable ("remember that…", a preference, a
   decision), call `write_memory`.
2. Before answering a question that might depend on past sessions, call
   `search_memory` first, then rely on what it returns — memory index pointers in
   the system prompt are not themselves evidence.
