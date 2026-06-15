---
name: todo
description: Track a multi-step plan across turns of a session. Use when working through a task with several steps — record the steps, mark one in_progress, and tick them off as you go. Provides the todo_write tool.
license: MIT
metadata:
  origin: miniclaw-builtin
---

# Todo

Maintain a short, living plan with the `todo_write` tool. The model owns the
plan and rewrites it each turn.

## How to use

- Call `todo_write` with the COMPLETE plan each time — include unchanged items
  too; the call replaces the whole list.
- Each item has `content` and a `status`: `pending`, `in_progress`, or
  `completed`. Keep at most one item `in_progress`.
- Use it for multi-step work you're actively doing; durable, long-term goals
  belong in memory (`write_memory`), not here. The plan is in-memory and resets
  when the process restarts.
