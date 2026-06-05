import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider, type AnthropicMessagesClient } from "../src/index.ts";

// Build a synthetic SDK `Message` so tests can drive provider.chat() without
// hitting the network. We only fill in the fields the provider reads.
function fakeMessage(opts: {
  textBlocks?: string[];
  toolUseBlocks?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason?: Anthropic.Message["stop_reason"];
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = [];
  for (const t of opts.textBlocks ?? []) {
    content.push({ type: "text", text: t, citations: null } as unknown as Anthropic.ContentBlock);
  }
  for (const u of opts.toolUseBlocks ?? []) {
    content.push({ type: "tool_use", id: u.id, name: u.name, input: u.input } as unknown as Anthropic.ContentBlock);
  }
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content,
    stop_reason: opts.stopReason ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: opts.inputTokens ?? 0,
      output_tokens: opts.outputTokens ?? 0,
      ...(opts.cacheRead !== undefined ? { cache_read_input_tokens: opts.cacheRead } : {}),
      ...(opts.cacheWrite !== undefined ? { cache_creation_input_tokens: opts.cacheWrite } : {}),
    },
  } as unknown as Anthropic.Message;
}

function clientFromCreate(impl: AnthropicMessagesClient["create"]): { messages: AnthropicMessagesClient } {
  return {
    messages: {
      create: impl,
      // Default stream() throws so non-streaming tests prove they took the
      // non-streaming path.
      stream: () => { throw new Error("non-streaming path expected"); },
    },
  };
}

describe("AnthropicProvider — non-streaming", () => {
  it("returns kind=final with text and usage", async () => {
    const create = vi.fn(async () =>
      fakeMessage({
        textBlocks: ["hello world"],
        stopReason: "end_turn",
        inputTokens: 42,
        outputTokens: 13,
      }),
    );
    const provider = new AnthropicProvider({
      model: "test-model",
      client: clientFromCreate(create),
    });

    const turn = await provider.chat({ system: "s", messages: [], tools: [] });
    expect(turn.kind).toBe("final");
    if (turn.kind === "final") {
      expect(turn.text).toBe("hello world");
      expect(turn.usage).toEqual({ inputTokens: 42, outputTokens: 13 });
    }
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("returns kind=tool_use with stable per-call IDs from the SDK", async () => {
    const create = vi.fn(async () =>
      fakeMessage({
        textBlocks: ["let me check"],
        toolUseBlocks: [
          { id: "toolu_01ABC", name: "shell", input: { bin: "ls" } },
          { id: "toolu_02XYZ", name: "shell", input: { bin: "pwd" } },
        ],
        stopReason: "tool_use",
        inputTokens: 100,
        outputTokens: 25,
      }),
    );
    const provider = new AnthropicProvider({
      model: "m",
      client: clientFromCreate(create),
    });
    const turn = await provider.chat({ system: "s", messages: [], tools: [] });
    expect(turn.kind).toBe("tool_use");
    if (turn.kind === "tool_use") {
      expect(turn.text).toBe("let me check");
      expect(turn.toolCalls.map((c) => c.id)).toEqual(["toolu_01ABC", "toolu_02XYZ"]);
      expect(turn.toolCalls[0]!.args).toEqual({ bin: "ls" });
      expect(turn.usage).toEqual({ inputTokens: 100, outputTokens: 25 });
    }
  });

  it("infers tool_use even if stop_reason isn't 'tool_use' but tool_use blocks are present", async () => {
    const create = vi.fn(async () =>
      fakeMessage({
        toolUseBlocks: [{ id: "tu_1", name: "x", input: { a: 1 } }],
        stopReason: "end_turn",
      }),
    );
    const provider = new AnthropicProvider({
      model: "m",
      client: clientFromCreate(create),
    });
    const turn = await provider.chat({ system: "s", messages: [], tools: [] });
    expect(turn.kind).toBe("tool_use");
  });

  it("captures cache-read / cache-write usage fields when present", async () => {
    const create = vi.fn(async () =>
      fakeMessage({
        textBlocks: ["cached!"],
        stopReason: "end_turn",
        inputTokens: 5,
        outputTokens: 7,
        cacheRead: 1234,
        cacheWrite: 0,
      }),
    );
    const provider = new AnthropicProvider({
      model: "m",
      client: clientFromCreate(create),
    });
    const turn = await provider.chat({ system: "s", messages: [], tools: [] });
    expect(turn.usage).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      cacheReadTokens: 1234,
      cacheWriteTokens: 0,
    });
  });

  it("propagates a 429 error to the caller (retry happens in @miniclaw/agent)", async () => {
    const err = Object.assign(new Error("rate_limit_error"), { status: 429 });
    const create = vi.fn(async () => { throw err; });
    const provider = new AnthropicProvider({
      model: "m",
      client: clientFromCreate(create),
    });
    await expect(provider.chat({ system: "s", messages: [], tools: [] })).rejects.toThrow(/rate_limit_error/);
  });
});

describe("AnthropicProvider — streaming", () => {
  it("uses stream() when onToken is provided and emits deltas as they arrive", async () => {
    const deltas: string[] = ["Hel", "lo, ", "wor", "ld"];
    let textListener: ((s: string) => void) | undefined;
    const stream = {
      on(event: string, listener: (s: string) => void) {
        if (event === "text") textListener = listener;
        return this;
      },
      async finalMessage() {
        return fakeMessage({
          textBlocks: ["Hello, world"],
          stopReason: "end_turn",
          inputTokens: 4,
          outputTokens: 6,
        });
      },
    };
    const client = {
      messages: {
        create: vi.fn(async () => { throw new Error("create() should not run when onToken is set"); }),
        stream: vi.fn(() => {
          // Drive the deltas asynchronously so the harness sees them stream.
          queueMicrotask(() => deltas.forEach((d) => textListener?.(d)));
          return stream;
        }),
      },
    };
    const provider = new AnthropicProvider({ model: "m", client });

    const received: string[] = [];
    const turn = await provider.chat({
      system: "s",
      messages: [],
      tools: [],
      onToken: (d) => received.push(d),
    });
    expect(client.messages.stream).toHaveBeenCalledTimes(1);
    expect(client.messages.create).not.toHaveBeenCalled();
    expect(received).toEqual(deltas);
    expect(turn.kind).toBe("final");
    if (turn.kind === "final") expect(turn.text).toBe("Hello, world");
    expect(turn.usage).toEqual({ inputTokens: 4, outputTokens: 6 });
  });

  it("doesn't crash when the onToken sink throws", async () => {
    const stream = {
      on(event: string, listener: (s: string) => void) {
        if (event === "text") queueMicrotask(() => listener("chunk"));
        return this;
      },
      async finalMessage() {
        return fakeMessage({ textBlocks: ["ok"], stopReason: "end_turn" });
      },
    };
    const provider = new AnthropicProvider({
      model: "m",
      client: {
        messages: {
          create: async () => { throw new Error("nope"); },
          stream: () => stream,
        },
      },
    });
    const turn = await provider.chat({
      system: "s",
      messages: [],
      tools: [],
      onToken: () => { throw new Error("ui boom"); },
    });
    expect(turn.kind).toBe("final");
  });
});
