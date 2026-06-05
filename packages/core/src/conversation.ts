// Short-term conversation history contract. Distinct from MemoryStore so
// transcript storage and long-term memory can evolve independently.

export interface MessageRecord {
  id: number;
  convId: number;
  role: string;
  content: string;
  toolCallsJson: string | null;
  createdAt: number;
}

export interface ConversationSummary {
  id: number;
  startedAt: number;
  /** Most recent message's createdAt; equals startedAt for empty conversations. */
  lastActivityAt: number;
  messageCount: number;
}

export interface ConversationStore {
  newConversation(): number;
  logTurn(convId: number, role: string, content: string, toolCallsJson?: string | null): void;
  recentMessages(convId: number, limit: number): MessageRecord[];
  /**
   * List conversation rows newest-first. Used by REPL meta-commands and
   * future HTTP "open a prior session" flows. Returns an empty array
   * when nothing has been stored yet.
   */
  listConversations(limit?: number): ConversationSummary[];
  /**
   * Return every message in the conversation, oldest-first. Returns an
   * empty array if the conversation id doesn't exist. Used by /resume
   * and by the windowed-context manager when a conversation handoff
   * needs the full transcript instead of just the recent window.
   */
  loadConversation(convId: number): MessageRecord[];
}
