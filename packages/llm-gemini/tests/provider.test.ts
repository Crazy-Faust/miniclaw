import { describe, expect, it, vi } from "vitest";
import {
  GeminiProvider,
  type GeminiGenerationResponse,
  type GeminiModelsClient,
} from "../src/index.ts";

interface FakePart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
}

function fakeResponse(opts: {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}): GeminiGenerationResponse {
  const parts: FakePart[] = [];
  if (opts.text) parts.push({ text: opts.text });
  for (const tc of opts.toolCalls ?? []) {
    parts.push({ functionCall: { name: tc.name, args: tc.args } });
  }
  return {
    candidates: [
      {
        content: { parts },
        finishReason: opts.finishReason ?? "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: opts.inputTokens ?? 0,
      candidatesTokenCount: opts.outputTokens ?? 0,
      ...(opts.cachedTokens !== undefined ? { cachedContentTokenCount: opts.cachedTokens } : {}),
    },
  };
}

function clientFromImpls(impls: Partial<GeminiModelsClient>): { models: GeminiModelsClient } {
  return {
    models: {
      generateContent: impls.generateContent ?? (async () => { throw new Error("not implemented"); }),
      generateContentStream: impls.generateContentStream ?? (async () => { throw new Error("not implemented"); }),
    },
  };
}

describe("GeminiProvider — non-streaming", () => {
  it("returns kind=final and captures usage from usageMetadata", async () => {
    const gen = vi.fn(async () =>
      fakeResponse({
        text: "hello",
        finishReason: "STOP",
        inputTokens: 10,
        outputTokens: 3,
      }),
    );
    const provider = new GeminiProvider({
      model: "m",
      client: clientFromImpls({ generateContent: gen }),
    });
    const turn = await provider.chat({ system: "s", messages: [], tools: [] });
    expect(turn.kind).toBe("final");
    if (turn.kind === "final") {
      expect(turn.text).toBe("hello");
      expect(turn.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
    }
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it("returns kind=tool_use and synthesizes per-call IDs (Gemini doesn't provide them)", async () => {
    const gen = vi.fn(async () =>
      fakeResponse({
        toolCalls: [
          { name: "shell", args: { bin: "ls" } },
          { name: "shell", args: { bin: "pwd" } },
        ],
        finishReason: "STOP",
      }),
    );
    const provider = new GeminiProvider({
      model: "m",
      client: clientFromImpls({ generateContent: gen }),
    });
    const turn = await provider.chat({ system: "s", messages: [], tools: [] });
    expect(turn.kind).toBe("tool_use");
    if (turn.kind === "tool_use") {
      expect(turn.toolCalls.map((c) => c.id)).toEqual(["gemini-0", "gemini-1"]);
      expect(turn.toolCalls[0]!.name).toBe("shell");
      expect(turn.toolCalls[0]!.args).toEqual({ bin: "ls" });
    }
  });

  it("captures cachedContentTokenCount when present", async () => {
    const gen = vi.fn(async () =>
      fakeResponse({
        text: "ok",
        inputTokens: 50,
        outputTokens: 5,
        cachedTokens: 40,
      }),
    );
    const provider = new GeminiProvider({
      model: "m",
      client: clientFromImpls({ generateContent: gen }),
    });
    const turn = await provider.chat({ system: "s", messages: [], tools: [] });
    expect(turn.usage).toEqual({ inputTokens: 50, outputTokens: 5, cacheReadTokens: 40 });
  });

  it("doesn't call generateContentStream on the non-streaming path", async () => {
    const stream = vi.fn(async () => { throw new Error("should not be called"); });
    const gen = vi.fn(async () => fakeResponse({ text: "hi" }));
    const provider = new GeminiProvider({
      model: "m",
      client: clientFromImpls({ generateContent: gen, generateContentStream: stream }),
    });
    await provider.chat({ system: "s", messages: [], tools: [] });
    expect(stream).not.toHaveBeenCalled();
  });

  it("propagates upstream errors (retry happens in @miniclaw/agent)", async () => {
    const gen = vi.fn(async () => {
      throw Object.assign(new Error("503 service unavailable"), { status: 503 });
    });
    const provider = new GeminiProvider({
      model: "m",
      client: clientFromImpls({ generateContent: gen }),
    });
    await expect(provider.chat({ system: "s", messages: [], tools: [] })).rejects.toThrow(/503/);
  });

  it("returns empty final when candidates is empty (truncated upstream)", async () => {
    const gen = vi.fn(async () => ({ candidates: [] } as GeminiGenerationResponse));
    const provider = new GeminiProvider({
      model: "m",
      client: clientFromImpls({ generateContent: gen }),
    });
    const turn = await provider.chat({ system: "s", messages: [], tools: [] });
    expect(turn.kind).toBe("final");
    if (turn.kind === "final") expect(turn.text).toBe("");
  });
});

describe("GeminiProvider — streaming via generateContentStream", () => {
  function makeStream(chunks: GeminiGenerationResponse[]): AsyncIterable<GeminiGenerationResponse> {
    return {
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
      },
    };
  }

  it("uses generateContentStream when onToken is provided and assembles text", async () => {
    const chunks = [
      fakeResponse({ text: "Hel" }),
      fakeResponse({ text: "lo, " }),
      fakeResponse({ text: "world", finishReason: "STOP", inputTokens: 9, outputTokens: 4 }),
    ];
    const stream = vi.fn(async () => makeStream(chunks));
    const gen = vi.fn(async () => { throw new Error("non-streaming path expected"); });
    const provider = new GeminiProvider({
      model: "m",
      client: clientFromImpls({ generateContent: gen, generateContentStream: stream }),
    });
    const received: string[] = [];
    const turn = await provider.chat({
      system: "s",
      messages: [],
      tools: [],
      onToken: (d) => received.push(d),
    });
    expect(stream).toHaveBeenCalledTimes(1);
    expect(gen).not.toHaveBeenCalled();
    expect(received).toEqual(["Hel", "lo, ", "world"]);
    expect(turn.kind).toBe("final");
    if (turn.kind === "final") {
      expect(turn.text).toBe("Hello, world");
      expect(turn.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
    }
  });

  it("captures tool calls emitted across streamed chunks (id is synthesized)", async () => {
    const chunks = [
      fakeResponse({ text: "thinking…" }),
      fakeResponse({
        toolCalls: [{ name: "shell", args: { bin: "ls" } }],
        finishReason: "STOP",
        inputTokens: 12,
        outputTokens: 5,
      }),
    ];
    const stream = vi.fn(async () => makeStream(chunks));
    const provider = new GeminiProvider({
      model: "m",
      client: clientFromImpls({ generateContentStream: stream }),
    });
    const turn = await provider.chat({
      system: "s",
      messages: [],
      tools: [],
      onToken: () => {},
    });
    expect(turn.kind).toBe("tool_use");
    if (turn.kind === "tool_use") {
      expect(turn.toolCalls).toHaveLength(1);
      expect(turn.toolCalls[0]!.id).toMatch(/^gemini-\d+$/);
      expect(turn.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    }
  });

  it("a throwing onToken sink does not crash the stream", async () => {
    const chunks = [fakeResponse({ text: "x", finishReason: "STOP" })];
    const stream = vi.fn(async () => makeStream(chunks));
    const provider = new GeminiProvider({
      model: "m",
      client: clientFromImpls({ generateContentStream: stream }),
    });
    const turn = await provider.chat({
      system: "s",
      messages: [],
      tools: [],
      onToken: () => { throw new Error("boom"); },
    });
    expect(turn.kind).toBe("final");
  });
});
