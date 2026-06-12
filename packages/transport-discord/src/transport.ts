import type {
  ChannelAllowlist,
  PairingRecord,
  PairingStore,
  Transport,
} from "@miniclaw/core";
import type { Gateway } from "@miniclaw/gateway";
import type { DirectMessage, DiscordClient, DiscordClientFactory } from "./client.ts";
import { discordJsClientFactory } from "./discord-js-client.ts";

export interface DiscordTransportOpts {
  gateway: Gateway;
  allowlist: ChannelAllowlist;
  pairings: PairingStore;
  /** Bot token. Use a development bot for testing; production tokens deserve a secret store. */
  token: string;
  /** Override the underlying client. Tests inject a fake. */
  factory?: DiscordClientFactory;
  /**
   * Notification hook fired whenever a new pairing code is minted. The
   * default writes a line to stdout — the operator reads the daemon log,
   * shares the code with the user out-of-band, and the user types
   * `/pair <code>` in the DM to complete the handshake.
   */
  onPairingMinted?: (record: PairingRecord, sender: { userId: string; userName: string }) => void;
  /** Repeat interval for Discord typing indicators. Default 8000 ms. */
  typingIntervalMs?: number;
}

export class DiscordTransport implements Transport {
  readonly name = "discord";
  private client: DiscordClient | null = null;
  private started = false;

  constructor(private readonly opts: DiscordTransportOpts) {}

  async start(): Promise<void> {
    if (this.started) return;
    const factory = this.opts.factory ?? discordJsClientFactory;
    this.client = await factory.create();
    this.client.onDirectMessage((msg) => this.handleDM(msg));
    await this.client.connect(this.opts.token);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started || !this.client) return;
    await this.client.disconnect();
    this.client = null;
    this.started = false;
  }

  async sendToChannel(channel: string, text: string): Promise<boolean> {
    const prefix = "discord:dm:";
    if (!channel.startsWith(prefix)) return false;
    await this.safeSend(channel.slice(prefix.length), text);
    return true;
  }

  private async handleDM(msg: DirectMessage): Promise<void> {
    const channel = `discord:dm:${msg.userId}`;

    // 1. /pair handshake. Accepted even before the channel is allowed —
    // it's the whole point of pairing.
    const pairMatch = /^\/pair\s+([A-Z2-9]{4,16})\s*$/i.exec(msg.text.trim());
    if (pairMatch) {
      const redeemed = this.opts.pairings.redeemPairing(pairMatch[1]!.toUpperCase());
      if (redeemed === channel) {
        this.opts.allowlist.allowChannel(channel);
        await this.safeSend(msg.userId, "paired — go ahead and ask me anything.");
      } else if (redeemed !== null) {
        // Right code, wrong channel — refuse loudly.
        await this.safeSend(msg.userId, "that code wasn't minted for this account.");
      } else {
        await this.safeSend(msg.userId, "unknown or expired code.");
      }
      return;
    }

    // 2. Unauthorized senders get a pairing prompt.
    if (!this.opts.allowlist.isAllowed(channel)) {
      const rec = this.opts.pairings.mintPairing(channel);
      const notify = this.opts.onPairingMinted ?? this.defaultPairingNotice;
      notify(rec, { userId: msg.userId, userName: msg.userName });
      await this.safeSend(
        msg.userId,
        `this account is not paired with the miniclaw daemon. Ask the operator for the pairing code printed in the daemon log, then reply: /pair <code>`,
      );
      return;
    }

    // 3. Allowed sender — forward to the gateway and reply.
    const typing = this.startTyping(msg);
    try {
      const session = this.opts.gateway.attach(channel);
      const trace = await session.send(msg.text);
      typing.stop();
      await this.safeSend(msg.userId, trace.finalText.length > 0 ? trace.finalText : "(no reply)");
    } catch (err) {
      typing.stop();
      await this.safeSend(msg.userId, `error: ${(err as Error).message}`);
    }
  }

  private startTyping(msg: DirectMessage): { stop(): void } {
    if (!msg.sendTyping) return { stop() {} };
    let stopped = false;
    const send = async (): Promise<void> => {
      try {
        await msg.sendTyping?.();
      } catch {
        // Typing indicators are best-effort and should not affect the turn.
      }
    };
    void send();
    const interval = setInterval(() => {
      if (!stopped) void send();
    }, this.opts.typingIntervalMs ?? 8_000);
    return {
      stop() {
        stopped = true;
        clearInterval(interval);
      },
    };
  }

  private async safeSend(userId: string, text: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.sendDirectMessage(userId, text);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`discord: send to ${userId} failed:`, (err as Error).message);
    }
  }

  private defaultPairingNotice(
    rec: PairingRecord,
    sender: { userId: string; userName: string },
  ): void {
    // eslint-disable-next-line no-console
    console.log(
      `discord: pairing requested by ${sender.userName} (${sender.userId}) — code ${rec.code} expires ${new Date(rec.expiresAt).toISOString()}`,
    );
  }
}
