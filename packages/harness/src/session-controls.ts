import type { ConversationSummary } from "@miniclaw/core";

/**
 * Capabilities the harness exposes to meta-commands so they can drive
 * session state (clear, resume, swap model, force compaction). Each field
 * is optional — meta-commands tell the user "not supported" if the
 * capability they need wasn't wired in.
 *
 * The consumer (CLI, HTTP server, ...) wires these to the underlying
 * mutable state: rebuilding the agent for /clear or /resume, asking the
 * context manager to summarize for /compact, etc.
 */
export interface SessionControls {
  /** Begin a fresh conversation in the underlying store. The harness
   *  rebuilds the agent's context against the new id. */
  clear?(): Promise<void> | void;
  /** Force the context manager to run its compaction step right now. */
  compact?(): Promise<void> | void;
  /** Return the currently-active model identifier. */
  getModel?(): string;
  /** Switch to a different model. Throw to indicate "unsupported" or
   *  "unknown model"; the meta command surfaces the message. */
  setModel?(name: string): Promise<void> | void;
  /** Optional curated list of model identifiers the user can pick from. */
  listAvailableModels?(): string[];
  /** Return summaries of prior conversations, newest activity first. */
  listConversations?(limit?: number): ConversationSummary[];
  /** Load the conversation with the given id into the current session. */
  resume?(convId: number): Promise<void> | void;
  /**
   * Snapshot of session state for `/status`. The shape is open-ended so
   * different transports can volunteer different fields; the meta-command
   * prints each field as `key: value` in insertion order.
   */
  status?(): Record<string, string | number>;
  /**
   * Token + cost rollup for `/usage`. Implementations typically query the
   * audit log. `bySkill` is rendered in the order returned.
   */
  usage?(): {
    total: number;
    ok: number;
    failed: number;
    bySkill: Array<{ skill: string; count: number }>;
  };
}
