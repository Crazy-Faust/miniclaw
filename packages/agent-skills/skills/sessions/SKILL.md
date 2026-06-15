---
name: sessions
description: Inspect and coordinate with other agent sessions the gateway supervises. Use to list active sessions, read another session's history, send a message into another session, or spawn a new session on a channel. Provides sessions_list, sessions_history, sessions_send, sessions_spawn.
license: MIT
compatibility: Requires the gateway/daemon to be supervising sessions; cross-session sends are restricted to the same channel.
metadata:
  origin: miniclaw-builtin
---

# Sessions

Coordinate across the sessions the gateway is running (e.g. CLI + Discord DMs,
or cron-spawned sessions).

## Tools

- **`sessions_list`** — list recent/active sessions (id, channel, status, last
  activity).
- **`sessions_history`** — read the recent messages of a specific session before
  following up.
- **`sessions_send`** — send a message into another session as that channel's
  user; the remote session runs one turn and returns its final answer. The
  caller and target must share the same channel (enforced in multi-user mode).
- **`sessions_spawn`** — start a fresh session on a channel (ending any active
  one there); returns the new session id for later `sessions_send` calls.

## Notes

- Cross-session messaging is gated by channel ownership — you can't drive a
  session that belongs to a different user/channel.
