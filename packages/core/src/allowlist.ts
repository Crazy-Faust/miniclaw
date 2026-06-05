// Per-channel allowlist + pairing. Transports consult these so an
// unknown sender can't drive the agent without explicit authorization.
//
// Pairing flow (recommended):
//   1. Inbound message from channel X. allowlist.isAllowed(X) is false.
//   2. Transport mints a pairing code via pairings.mintPairing(X). It DMs
//      the code back to X with instructions ("reply /pair <code>").
//   3. User redeems via a transport-specific command. The transport
//      calls pairings.redeemPairing(code) → channel; if it matches X, the
//      transport calls allowlist.allowChannel(X). Subsequent messages flow.
//
// Codes are short-lived (default 10 minutes) and single-use. The store
// is responsible for expiring them.

// Method names are prefixed with `Channel` / `listAllowed` so SqliteStore
// can satisfy this alongside MemoryStore.add / CronStore.list without
// collisions.
export interface ChannelAllowlist {
  isAllowed(channel: string): boolean;
  allowChannel(channel: string): void;
  disallowChannel(channel: string): void;
  listAllowed(): string[];
}

export interface PairingRecord {
  /** The channel that initiated the request. */
  channel: string;
  /** Short, human-friendly secret printed back to the user. */
  code: string;
  /** ms since epoch — codes older than this are considered expired. */
  expiresAt: number;
}

export interface PairingStore {
  /**
   * Mint a new pairing record for the channel. Implementations should
   * invalidate any prior unredeemed code for the same channel so a stale
   * one can't be used.
   */
  mintPairing(channel: string, ttlMs?: number): PairingRecord;
  /**
   * Try to redeem a code. Returns the channel the code was minted for, or
   * null if the code is unknown or expired. Redemption MUST be single-use:
   * the implementation removes the record on a successful match.
   */
  redeemPairing(code: string): string | null;
}
