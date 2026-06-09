import type { DiscordClient, DiscordClientFactory, DirectMessage } from "./client.ts";

// Late binding wrapper around discord.js v14. The package is a normal
// dependency of transport-discord, but dynamic import keeps the boundary
// narrow and makes accidental install corruption fail with a clear message.

interface DiscordJsModule {
  Client: new (opts: { intents: number[]; partials?: number[] }) => DiscordJsClient;
  GatewayIntentBits: {
    Guilds: number;
    GuildMessages: number;
    DirectMessages: number;
    MessageContent: number;
  };
  Partials: {
    Channel: number;
    Message: number;
  };
  ChannelType: {
    DM: number;
  };
}

interface DiscordJsClient {
  user: { id: string } | null;
  login(token: string): Promise<string>;
  destroy(): Promise<void>;
  once(event: "ready" | "clientReady", cb: () => void): void;
  on(event: "messageCreate", cb: (msg: DiscordJsMessage) => void): void;
  users: {
    fetch(userId: string): Promise<{ send(text: string): Promise<unknown> }>;
  };
}

interface DiscordJsMessage {
  content: string;
  author: { bot: boolean; id: string; username: string; displayName?: string };
  channel: { type: number };
  reply?(text: string): Promise<unknown>;
}

export const discordJsClientFactory: DiscordClientFactory = {
  async create(): Promise<DiscordClient> {
    let mod: DiscordJsModule;
    try {
      mod = (await import("discord.js")) as unknown as DiscordJsModule;
    } catch (err) {
      throw new Error(
        `discord.js could not be loaded. Run \`pnpm install\` from the repo root and retry. ` +
          `(${(err as Error).message})`,
      );
    }

    const intents = mod.GatewayIntentBits;
    const partials = mod.Partials;
    const client = new mod.Client({
      intents: [intents.Guilds, intents.DirectMessages, intents.MessageContent, intents.GuildMessages],
      partials: [partials.Channel, partials.Message],
    });
    const DM_CHANNEL = mod.ChannelType.DM;

    let dmHandler: ((m: DirectMessage) => Promise<void> | void) | null = null;

    client.on("messageCreate", (msg) => {
      if (msg.author.bot) return;
      if (msg.channel.type !== DM_CHANNEL) return; // DMs only for v0.
      if (!dmHandler) return;
      void dmHandler({
        userId: msg.author.id,
        userName: msg.author.displayName ?? msg.author.username,
        text: msg.content,
      });
    });

    return {
      async connect(token: string): Promise<void> {
        const ready = new Promise<void>((resolve) => {
          // discord.js v14.16+ emits "clientReady" too — listen for both
          // so we work across the renamed window.
          client.once("ready", () => resolve());
          client.once("clientReady" as "ready", () => resolve());
        });
        await client.login(token);
        await ready;
      },
      async disconnect(): Promise<void> {
        await client.destroy();
      },
      onDirectMessage(handler): void {
        dmHandler = handler;
      },
      async sendDirectMessage(userId, text): Promise<void> {
        const user = await client.users.fetch(userId);
        // Discord caps DMs at 2000 chars. Split rather than truncate so
        // long agent answers still arrive in full.
        for (const chunk of splitForDiscord(text)) {
          await user.send(chunk);
        }
      },
    };
  },
};

const DM_LIMIT = 1900;

export function splitForDiscord(text: string): string[] {
  if (text.length <= DM_LIMIT) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + DM_LIMIT));
    i += DM_LIMIT;
  }
  return out;
}
