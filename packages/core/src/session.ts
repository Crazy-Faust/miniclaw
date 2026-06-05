// Long-running session contract. The gateway daemon supervises many
// sessions in parallel (one per channel + user pair). Each session has
// its own conversation history; the session row holds the metadata.

export interface SessionRecord {
  /** Stable id, used as the conversation key. */
  id: string;
  /** Logical transport identifier (e.g. "cli", "http", "telegram:42"). */
  channel: string;
  /** Agent profile name. Reserved — currently always "default". */
  agent: string;
  /** "active" or "ended". */
  status: string;
  /** ms since epoch. */
  createdAt: number;
  /** ms since epoch — last time a message was appended. */
  lastActivityAt: number;
  /** Conversation id this session reads/writes into via ConversationStore. */
  conversationId: number;
}

// Method names are prefixed with `session` so SqliteStore can satisfy this
// alongside MemoryStore / CronStore without overload gymnastics.
export interface SessionStore {
  /**
   * Find an existing active session by channel, or create a new one. The
   * user component is included in the channel key (e.g. "telegram:42") so
   * the gateway can keep its public surface a single string.
   */
  findOrCreateSession(channel: string, conversationId: number, agent?: string): SessionRecord;
  /** Mark a session as ended; the gateway stops dispatching to it. */
  endSession(id: string): void;
  /** Bump lastActivityAt to now. Called after every successful turn. */
  touchSession(id: string): void;
  /** Newest-first. */
  listSessions(limit?: number): SessionRecord[];
  getSession(id: string): SessionRecord | null;
}
