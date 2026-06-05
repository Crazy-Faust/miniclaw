import type { Agent, AgentTurnHooks, TurnTrace } from "@miniclaw/agent";
import type {
  ConversationStore,
  MessageRecord,
  SessionRecord,
  SessionStore,
} from "@miniclaw/core";

export interface GatewayOpts {
  /**
   * Backing store for session metadata. The same SqliteStore typically
   * satisfies this and ConversationStore.
   */
  sessions: SessionStore;
  /**
   * Conversations are where the actual turn history lives. The gateway
   * spawns one conversation per session so prompts in channel A don't
   * leak into channel B.
   */
  conversations: ConversationStore;
  /**
   * Build (or fetch) the agent for a given session. Implementations can
   * return the same Agent for every session (current default) or build
   * per-session agents so each can have its own ContextManager bound to
   * the session's conversation id.
   */
  agentFor(session: SessionRecord): Agent;
}

/**
 * In-process supervisor. One Gateway per daemon. Wraps the existing
 * Agent + ConversationStore behind a session-aware API so transports
 * (CLI, HTTP, Telegram, ...) can attach by channel without knowing how
 * the agent is wired.
 */
export class Gateway {
  constructor(private readonly opts: GatewayOpts) {}

  /**
   * Find or create the session for a channel. Idempotent — a transport
   * can call this on every inbound message and either get the existing
   * session or, on first contact, spawn one transparently.
   */
  attach(channel: string, agentName = "default"): GatewaySession {
    const existing = this.opts.sessions.listSessions(50).find(
      (s) => s.channel === channel && s.status === "active",
    );
    let record: SessionRecord;
    if (existing) {
      record = existing;
    } else {
      const convId = this.opts.conversations.newConversation();
      record = this.opts.sessions.findOrCreateSession(channel, convId, agentName);
    }
    return new GatewaySession(record, this.opts);
  }

  /**
   * Force a fresh session for `channel` — ends any existing active session
   * first so the new one becomes the unique active record. Use this when
   * the user explicitly says "start over"; routine inbound messages
   * should call attach() instead.
   */
  spawn(channel: string, agentName = "default"): GatewaySession {
    for (const s of this.opts.sessions.listSessions(50)) {
      if (s.channel === channel && s.status === "active") {
        this.opts.sessions.endSession(s.id);
      }
    }
    const convId = this.opts.conversations.newConversation();
    const record = this.opts.sessions.findOrCreateSession(channel, convId, agentName);
    return new GatewaySession(record, this.opts);
  }

  list(limit = 50): SessionRecord[] {
    return this.opts.sessions.listSessions(limit);
  }

  history(sessionId: string, limit = 50): MessageRecord[] {
    const rec = this.opts.sessions.getSession(sessionId);
    if (!rec) return [];
    return this.opts.conversations.recentMessages(rec.conversationId, limit);
  }

  end(sessionId: string): void {
    this.opts.sessions.endSession(sessionId);
  }
}

/**
 * Wrapper returned by Gateway.attach(). Holds the SessionRecord and
 * forwards user input to the agent, stamping lastActivityAt and
 * isolating the conversation per session.
 */
export class GatewaySession {
  constructor(
    public readonly record: SessionRecord,
    private readonly opts: GatewayOpts,
  ) {}

  async send(userMsg: string, hooks?: AgentTurnHooks): Promise<TurnTrace> {
    const agent = this.opts.agentFor(this.record);
    try {
      return await agent.runTurn(userMsg, hooks);
    } finally {
      this.opts.sessions.touchSession(this.record.id);
    }
  }
}
