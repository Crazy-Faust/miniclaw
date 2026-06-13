import { describe, expect, it, beforeEach } from "vitest";
import type { Agent } from "@miniclaw/agent";
import { Gateway } from "@miniclaw/gateway";
import { InMemoryStore } from "@miniclaw/memory-inmemory";
import type { DirectMessage, DiscordClient, DiscordClientFactory } from "../src/client.ts";
import { DiscordTransport } from "../src/transport.ts";
import { splitForDiscord } from "../src/discord-js-client.ts";

function fakeClient() {
  let handler: ((m: DirectMessage) => Promise<void> | void) | null = null;
  const sent: Array<{ userId: string; text: string }> = [];
  let connected = false;
  const client: DiscordClient = {
    async connect() { connected = true; },
    async disconnect() { connected = false; },
    onDirectMessage(h) { handler = h; },
    async sendDirectMessage(userId, text) { sent.push({ userId, text }); },
  };
  return {
    client,
    factory: { async create() { return client; } } satisfies DiscordClientFactory,
    sent,
    get connected() { return connected; },
    async deliver(m: DirectMessage) {
      if (!handler) throw new Error("not subscribed");
      await handler(m);
    },
  };
}

function makeAgent(): Agent {
  return {
    async runTurn(userMsg: string) {
      return { toolCalls: [], finalText: `echo:${userMsg}` };
    },
  } as unknown as Agent;
}

describe("DiscordTransport", () => {
  let store: InMemoryStore;
  let gateway: Gateway;
  let fake: ReturnType<typeof fakeClient>;
  let transport: DiscordTransport;

  beforeEach(async () => {
    store = new InMemoryStore();
    gateway = new Gateway({
      sessions: store,
      conversations: store,
      agentFor: () => makeAgent(),
    });
    fake = fakeClient();
    transport = new DiscordTransport({
      gateway,
      allowlist: store,
      pairings: store,
      token: "x",
      factory: fake.factory,
      onPairingMinted: () => undefined,
    });
    await transport.start();
  });

  it("DMs an unknown sender a pairing prompt", async () => {
    await fake.deliver({ userId: "u1", userName: "alice", text: "hello" });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.userId).toBe("u1");
    expect(fake.sent[0]!.text).toMatch(/pair/i);
  });

  it("mints a pairing code that can be redeemed", async () => {
    let mintedCode = "";
    transport = new DiscordTransport({
      gateway,
      allowlist: store,
      pairings: store,
      token: "x",
      factory: fake.factory,
      onPairingMinted: (rec) => { mintedCode = rec.code; },
    });
    await transport.start();
    await fake.deliver({ userId: "u1", userName: "alice", text: "hello" });
    expect(mintedCode.length).toBeGreaterThanOrEqual(4);

    // The sender redeems
    await fake.deliver({ userId: "u1", userName: "alice", text: `/pair ${mintedCode}` });
    expect(store.isAllowed("discord:dm:u1")).toBe(true);

    // Now a real message forwards to the agent and the reply comes back.
    await fake.deliver({ userId: "u1", userName: "alice", text: "ping" });
    const replies = fake.sent.map((s) => s.text);
    expect(replies).toContain("echo:ping");
  });

  it("rejects a code minted for a different channel", async () => {
    const rec = store.mintPairing("discord:dm:other");
    await fake.deliver({ userId: "u1", userName: "alice", text: `/pair ${rec.code}` });
    const last = fake.sent[fake.sent.length - 1]!.text;
    expect(last).toMatch(/wasn't minted for this account/i);
    expect(store.isAllowed("discord:dm:u1")).toBe(false);
  });

  it("reports an unknown code", async () => {
    await fake.deliver({ userId: "u1", userName: "alice", text: "/pair BOGUSCODE" });
    const last = fake.sent[fake.sent.length - 1]!.text;
    expect(last).toMatch(/unknown or expired/i);
  });

  it("forwards messages from an already-allowed channel directly", async () => {
    store.allowChannel("discord:dm:u1");
    await fake.deliver({ userId: "u1", userName: "alice", text: "what's 2+2" });
    const last = fake.sent[fake.sent.length - 1]!.text;
    expect(last).toBe("echo:what's 2+2");
  });

  it("sends a typing indicator while an allowed DM is processing", async () => {
    let releaseTurn!: () => void;
    let startedTurn!: () => void;
    const started = new Promise<void>((resolve) => { startedTurn = resolve; });
    const release = new Promise<void>((resolve) => { releaseTurn = resolve; });
    gateway = new Gateway({
      sessions: store,
      conversations: store,
      agentFor: () => ({
        async runTurn(userMsg: string) {
          startedTurn();
          await release;
          return { toolCalls: [], finalText: `echo:${userMsg}` };
        },
      } as unknown as Agent),
    });
    fake = fakeClient();
    transport = new DiscordTransport({
      gateway,
      allowlist: store,
      pairings: store,
      token: "x",
      factory: fake.factory,
      typingIntervalMs: 10,
    });
    await transport.start();
    store.allowChannel("discord:dm:u1");
    let typingCalls = 0;

    const delivered = fake.deliver({
      userId: "u1",
      userName: "alice",
      text: "slow",
      sendTyping: async () => { typingCalls++; },
    });
    await started;

    expect(typingCalls).toBeGreaterThan(0);
    releaseTurn();
    await delivered;
    expect(fake.sent[fake.sent.length - 1]).toEqual({ userId: "u1", text: "echo:slow" });
  });

  it("sendToChannel sends proactive messages to Discord DM channels", async () => {
    await expect(transport.sendToChannel("discord:dm:u1", "take out the trash")).resolves.toBe(true);
    expect(fake.sent[fake.sent.length - 1]).toEqual({
      userId: "u1",
      text: "take out the trash",
    });
    await expect(transport.sendToChannel("cli", "nope")).resolves.toBe(false);
  });

  it("stop() disconnects the client", async () => {
    expect(fake.connected).toBe(true);
    await transport.stop();
    expect(fake.connected).toBe(false);
  });
});

describe("splitForDiscord", () => {
  it("returns one chunk for short text", () => {
    expect(splitForDiscord("hi")).toEqual(["hi"]);
  });
  it("splits text longer than the limit", () => {
    const text = "x".repeat(5000);
    const chunks = splitForDiscord(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });
});
