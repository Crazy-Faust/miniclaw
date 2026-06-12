// Minimal abstraction over discord.js. Skipping the full Client surface
// keeps the transport testable without spinning up a real bot and lets
// us swap libraries (eris, oceanic, raw REST) if discord.js ever
// becomes a bad fit.

export interface DirectMessage {
  /** Stable Discord user id of the sender. */
  userId: string;
  /** Display name — used only in logs / pairing notifications. */
  userName: string;
  /** Message body. */
  text: string;
  /** Send a transient typing indicator in the source DM channel. */
  sendTyping?: () => Promise<void>;
}

export interface DiscordClient {
  /**
   * Connect to Discord and begin handling events. Resolves once the
   * gateway READY event fires.
   */
  connect(token: string): Promise<void>;
  /** Disconnect cleanly. Idempotent. */
  disconnect(): Promise<void>;
  /**
   * Subscribe to direct messages. The transport calls this once during
   * start(). Implementations MUST filter out the bot's own messages.
   */
  onDirectMessage(handler: (msg: DirectMessage) => Promise<void> | void): void;
  /** Send a DM to a specific user id. */
  sendDirectMessage(userId: string, text: string): Promise<void>;
}

export interface DiscordClientFactory {
  create(): Promise<DiscordClient>;
}
