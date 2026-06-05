// Long-running message-source contract. A Transport listens on some
// external channel (Discord gateway, Telegram polling, Slack socket
// mode, ...) and routes inbound messages to the gateway by attaching to
// a per-sender channel id. The daemon owns the Transport lifecycle.
//
// IOAdapter (in @miniclaw/harness) and Transport are different shapes
// on purpose: IOAdapter is a single-user REPL stream; Transport is a
// fan-in multiplexer that emits N concurrent conversations.

export interface Transport {
  /** Short identifier — "discord", "telegram", "slack", etc. */
  name: string;
  /** Connect and begin handling messages. Resolves once connected. */
  start(): Promise<void>;
  /** Disconnect cleanly. Idempotent. */
  stop(): Promise<void>;
}
