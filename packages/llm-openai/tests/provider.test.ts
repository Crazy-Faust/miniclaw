import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../src/index.ts";

function fakeCompletion(opts: {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; argsJson: string }>;
  finishReason?: OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"];
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: "cmpl_test",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: opts.text ?? null,
          refusal: null,
          tool_calls: (opts.toolCalls ?? []).map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.argsJson },
          })),
        },
        finish_reason: opts.finishReason ?? "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: opts.inputTokens ?? 0,
      completion_tokens: opts.outputTokens ?? 0,
      total_tokens: (opts.inputTokens ?? 0) + (opts.outputTokens ?? 0),
      ...(opts.cachedTokens !== undefined
        ? { prompt_tokens_details: { cached_tokens: opts.cachedTokens } }
        : {}),
    },
  } as unknown as OpenAI.Chat.Completions.ChatCompletion;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clientFromCreate(impl: (params: any) => any): any {
  return { chat: { completions: { create: impl } } };
}

describe("OpenAIProvider — non-streaming", () => {
  it("returns kind=final and surfaces usage as prompt/completion tokens", async () => {
    const create = vi.fn(async (_p: Record<string, unknown>) =>
      fakeCompletion({
        text: "hi",
        finishReason: "stop",
        inputTokens: 11,
        outputTokens: 3,
      }),
    );
    const provider = new OpenAIProvider({
      model: "m",
      client: clientFromCreate(create),
    });
    const turn = await provider.chat({ system: "s", messages: [], tools: [] });
    expect(turn.kind).toBe("final");
    if (turn.kind === "final") {
      expect(turn.text).toBe("hi");
      expect(turn.usage).toEqual({ inputTokens: 11, outputTokens: 3 });
    }
    // Non-streaming params include stream:false.
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ stream: false }));
  });

  it("returns kind=tool_use carrying the SDK's per-call IDs (finish_reason=tool_calls)", async () => {
    const create = vi.fn(async (_p: Record<string, unknown>) =>
      fakeCompletion({
        toolCalls: [
          { id: "call_aaaaa", name: "shell", argsJson: JSON.stringify({ bin: "ls" }) },
          { id: "call_bbbbb", name: "shell", argsJson: JSON.stringify({ bin: "pwd" }) },
        ],
        finishReason: "tool_calls",
      }),
    );
    const provider = new OpenAIProvider({ model: "m", client: clientFromCreate(create) });
    const turn = await provider.chat({ system: "s", messages: [], tools: [] });
    expect(turn.kind).toBe("tool_use");
    if (turn.kind === "tool_use") {
      expect(turn.toolCalls.map((c) => c.id)).toEqual(["call_aaaaa", "call_bbbbb"]);
      expect(turn.toolCalls[0]!.args).toEqual({ bin: "ls" });
    }
  });

  it("infers tool_use when tool_calls are present even if finish_reason is 'stop' (defensive)", async () => {
    const create = vi.fn(async (_p: Record<string, unknown>) =>
      fakeCompletion({
        toolCalls: [{ id: "call_x", name: "x", argsJson: "{}" }],
        finishReason: "stop",
      }),
    );
    const provider = new OpenAIProvider({ model: "m", client: clientFromCreate(create) });
    const turn = await provider.chat({ system: "s", messages: [], tools: [] });
    expect(turn.kind).toBe("tool_use");
  });

  it("returns empty final when choices is empty (truncated upstream response)", async () => {
    const create = vi.fn(async (_p: Record<string, unknown>) => ({
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    }));
    const provider = new OpenAIProvider({
      model: "m",
      client: clientFromCreate(create as unknown as (p: Record<string, unknown>) => unknown),
    });
    const turn = await provider.chat({ system: "s", messages: [], tools: [] });
    expect(turn.kind).toBe("final");
    if (turn.kind === "final") expect(turn.text).toBe("");
  });

  // ---- The __raw malformed-args fallback ----
  // The OpenAI API sometimes returns invalid JSON in function.arguments
  // (truncated, stringified, etc.). Rather than throwing inside the provider,
  // we wrap the raw payload under { __raw } so the agent's zod validator can
  // turn it into a clean "invalid arguments" tool result that the model can
  // recover from.
  it("wraps malformed tool args under __raw instead of throwing", async () => {
    const create = vi.fn(async (_p: Record<string, unknown>) =>
      fakeCompletion({
        toolCalls: [{ id: "call_bad", name: "shell", argsJson: "{not-json" }],
        finishReason: "tool_calls",
      }),
    );
    const provider = new OpenAIProvider({ model: "m", client: clientFromCreate(create) });
    const turn = await provider.chat({ system: "s", messages: [], tools: [] });
    expect(turn.kind).toBe("tool_use");
    if (turn.kind === "tool_use") {
      expect(turn.toolCalls).toHaveLength(1);
      expect(turn.toolCalls[0]!.args).toEqual({ __raw: "{not-json" });
    }
  });

  it("normalizes empty arguments to {} (avoids needing __raw)", async () => {
    const create = vi.fn(async (_p: Record<string, unknown>) =>
      fakeCompletion({
        toolCalls: [{ id: "call_empty", name: "x", argsJson: "" }],
        finishReason: "tool_calls",
      }),
    );
    const provider = new OpenAIProvider({ model: "m", client: clientFromCreate(create) });
    const turn = await provider.chat({ system: "s", messages: [], tools: [] });
    if (turn.kind === "tool_use") {
      expect(turn.toolCalls[0]!.args).toEqual({});
    }
  });

  it("captures cached_tokens from prompt_tokens_details when present", async () => {
    const create = vi.fn(async (_p: Record<string, unknown>) =>
      fakeCompletion({
        text: "cached",
        inputTokens: 100,
        outputTokens: 5,
        cachedTokens: 80,
      }),
    );
    const provider = new OpenAIProvider({ model: "m", client: clientFromCreate(create) });
    const turn = await provider.chat({ system: "s", messages: [], tools: [] });
    expect(turn.usage).toEqual({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 80 });
  });

  it("propagates 429 to the caller (retry happens in @miniclaw/agent)", async () => {
    const create = vi.fn(async (_p: Record<string, unknown>) => {
      throw Object.assign(new Error("rate limited"), { status: 429 });
    });
    const provider = new OpenAIProvider({ model: "m", client: clientFromCreate(create) });
    await expect(provider.chat({ system: "s", messages: [], tools: [] })).rejects.toThrow(/rate/);
  });
});

describe("OpenAIProvider — streaming", () => {
  function makeStream(chunks: OpenAI.Chat.Completions.ChatCompletionChunk[]): AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> {
    return {
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
      },
    };
  }

  function deltaChunk(
    delta: { content?: string; tool_calls?: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[] },
    finishReason: OpenAI.Chat.Completions.ChatCompletionChunk.Choice["finish_reason"] = null,
  ): OpenAI.Chat.Completions.ChatCompletionChunk {
    return {
      id: "chunk",
      object: "chat.completion.chunk",
      created: 0,
      model: "m",
      choices: [
        { index: 0, delta: delta as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta, finish_reason: finishReason, logprobs: null },
      ],
    } as unknown as OpenAI.Chat.Completions.ChatCompletionChunk;
  }

  function usageChunk(prompt: number, completion: number): OpenAI.Chat.Completions.ChatCompletionChunk {
    return {
      id: "chunk-usage",
      object: "chat.completion.chunk",
      created: 0,
      model: "m",
      choices: [],
      usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
    } as unknown as OpenAI.Chat.Completions.ChatCompletionChunk;
  }

  it("uses stream:true when onToken is set; emits assembled text and usage", async () => {
    const chunks = [
      deltaChunk({ content: "Hel" }),
      deltaChunk({ content: "lo, " }),
      deltaChunk({ content: "world" }, "stop"),
      usageChunk(7, 5),
    ];
    let seenParams: Record<string, unknown> | undefined;
    const provider = new OpenAIProvider({
      model: "m",
      client: clientFromCreate(async (p: Record<string, unknown>) => {
        seenParams = p;
        return makeStream(chunks);
      }),
    });

    const received: string[] = [];
    const turn = await provider.chat({
      system: "s",
      messages: [],
      tools: [],
      onToken: (d) => received.push(d),
    });
    expect(seenParams).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(received).toEqual(["Hel", "lo, ", "world"]);
    expect(turn.kind).toBe("final");
    if (turn.kind === "final") expect(turn.text).toBe("Hello, world");
    expect(turn.usage).toEqual({ inputTokens: 7, outputTokens: 5 });
  });

  it("reassembles streamed tool_calls by index and parses the joined arguments JSON", async () => {
    // Two distinct tool calls split across multiple chunks. The SDK delivers
    // the id once (on the first delta) and streams the arguments string in
    // pieces; we merge by `index`.
    const chunks = [
      deltaChunk({
        tool_calls: [
          { index: 0, id: "call_a", type: "function", function: { name: "shell", arguments: "" } },
          { index: 1, id: "call_b", type: "function", function: { name: "shell", arguments: "" } },
        ] as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[],
      }),
      deltaChunk({
        tool_calls: [{ index: 0, function: { arguments: '{"bin":"ls"' } }] as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[],
      }),
      deltaChunk({
        tool_calls: [{ index: 0, function: { arguments: "}" } }] as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[],
      }),
      deltaChunk({
        tool_calls: [{ index: 1, function: { arguments: '{"bin":"pwd"}' } }] as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[],
      }, "tool_calls"),
      usageChunk(20, 5),
    ];
    const provider = new OpenAIProvider({
      model: "m",
      client: clientFromCreate(async (_p: Record<string, unknown>) => makeStream(chunks)),
    });
    const turn = await provider.chat({
      system: "s",
      messages: [],
      tools: [],
      onToken: () => {},
    });
    expect(turn.kind).toBe("tool_use");
    if (turn.kind === "tool_use") {
      expect(turn.toolCalls).toHaveLength(2);
      expect(turn.toolCalls[0]).toMatchObject({ id: "call_a", name: "shell", args: { bin: "ls" } });
      expect(turn.toolCalls[1]).toMatchObject({ id: "call_b", name: "shell", args: { bin: "pwd" } });
      expect(turn.usage).toEqual({ inputTokens: 20, outputTokens: 5 });
    }
  });

  it("streaming path also wraps malformed args under __raw", async () => {
    const chunks = [
      deltaChunk({
        tool_calls: [
          { index: 0, id: "call_bad", type: "function", function: { name: "shell", arguments: "{oops" } },
        ] as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[],
      }, "tool_calls"),
    ];
    const provider = new OpenAIProvider({
      model: "m",
      client: clientFromCreate(async (_p: Record<string, unknown>) => makeStream(chunks)),
    });
    const turn = await provider.chat({
      system: "s",
      messages: [],
      tools: [],
      onToken: () => {},
    });
    expect(turn.kind).toBe("tool_use");
    if (turn.kind === "tool_use") {
      expect(turn.toolCalls[0]!.args).toEqual({ __raw: "{oops" });
    }
  });

  it("a misbehaving onToken sink does not crash the stream", async () => {
    const chunks = [deltaChunk({ content: "x" }, "stop")];
    const provider = new OpenAIProvider({
      model: "m",
      client: clientFromCreate(async (_p: Record<string, unknown>) => makeStream(chunks)),
    });
    const turn = await provider.chat({
      system: "s",
      messages: [],
      tools: [],
      onToken: () => { throw new Error("boom"); },
    });
    expect(turn.kind).toBe("final");
    if (turn.kind === "final") expect(turn.text).toBe("x");
  });
});
