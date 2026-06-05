import OpenAI from "openai";
import type {
  AssistantTurn,
  LLMProvider,
  LLMUsage,
  Message,
  ToolCall,
  ToolSpec,
} from "@miniclaw/core";
import { toOpenAIMessagesAll } from "./mapping.ts";

// Structural subset of the SDK we touch. Lets tests inject a fake without
// dragging in OpenAI's full module surface.
export interface OpenAIChatCompletionsClient {
  create(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
  create(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>;
}

export interface OpenAIProviderOpts {
  apiKey?: string;
  model: string;
  /**
   * Override the OpenAI base URL. Set this to point at a local OpenAI-
   * compatible server (Ollama: http://localhost:11434/v1,
   * LM Studio: http://localhost:1234/v1, vLLM, etc.). When omitted, uses
   * api.openai.com.
   */
  baseURL?: string;
  maxTokens?: number;
  /** Inject a pre-built SDK client (or a fake in tests). */
  client?: { chat: { completions: OpenAIChatCompletionsClient } };
}

export class OpenAIProvider implements LLMProvider {
  private readonly client: { chat: { completions: OpenAIChatCompletionsClient } };
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: OpenAIProviderOpts) {
    if (opts.client) {
      this.client = opts.client;
    } else {
      if (!opts.apiKey) throw new Error("OpenAIProvider: apiKey or client required");
      this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    }
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 2048;
  }

  async chat(opts: {
    system: string;
    messages: Message[];
    tools: ToolSpec[];
    onToken?: (delta: string) => void;
  }): Promise<AssistantTurn> {
    const tools = opts.tools.map<OpenAI.Chat.Completions.ChatCompletionTool>((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));

    const baseParams = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [
        { role: "system" as const, content: opts.system },
        ...toOpenAIMessagesAll(opts.messages),
      ],
      tools: tools.length > 0 ? tools : undefined,
    };

    if (opts.onToken) {
      return await this.streamingChat(baseParams, opts.onToken);
    }
    return await this.nonStreamingChat(baseParams);
  }

  private async nonStreamingChat(
    baseParams: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "stream">,
  ): Promise<AssistantTurn> {
    const res = (await this.client.chat.completions.create({
      ...baseParams,
      stream: false,
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming)) as OpenAI.Chat.Completions.ChatCompletion;
    return assistantTurnFromChoice(res.choices[0], mapUsage(res.usage));
  }

  private async streamingChat(
    baseParams: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, "stream">,
    onToken: (delta: string) => void,
  ): Promise<AssistantTurn> {
    const streamParams = {
      ...baseParams,
      stream: true,
      // Ask the server to emit a final chunk that carries usage. Necessary
      // for usage-aware budgeting and the agent's "tokens-in/out" trace.
      stream_options: { include_usage: true },
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

    const stream = (await this.client.chat.completions.create(
      streamParams,
    )) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

    let assembledText = "";
    let finishReason: OpenAI.Chat.Completions.ChatCompletionChunk.Choice["finish_reason"] | null = null;
    // tool_calls in streaming arrive as deltas indexed by `index`. We merge by index.
    const toolByIndex = new Map<number, { id?: string; name?: string; args: string }>();
    let usage: LLMUsage | undefined;

    for await (const chunk of stream) {
      if (chunk.usage) usage = mapUsage(chunk.usage);
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (typeof delta.content === "string" && delta.content.length > 0) {
        assembledText += delta.content;
        try {
          onToken(delta.content);
        } catch {
          // Don't let a misbehaving UI sink kill the stream.
        }
      }
      for (const tc of delta.tool_calls ?? []) {
        const slot = toolByIndex.get(tc.index) ?? { args: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        toolByIndex.set(tc.index, slot);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const toolCalls: ToolCall[] = [];
    const indices = [...toolByIndex.keys()].sort((a, b) => a - b);
    for (const i of indices) {
      const slot = toolByIndex.get(i)!;
      toolCalls.push({
        id: slot.id ?? `openai-${i}`,
        name: slot.name ?? "",
        args: parseToolArgs(slot.args),
      });
    }

    const text = assembledText.trim();
    if (finishReason === "tool_calls" || toolCalls.length > 0) {
      return { kind: "tool_use", text, toolCalls, usage };
    }
    return { kind: "final", text, usage };
  }
}

function assistantTurnFromChoice(
  choice: OpenAI.Chat.Completions.ChatCompletion.Choice | undefined,
  usage: LLMUsage | undefined,
): AssistantTurn {
  if (!choice) {
    // Defensive: empty choices means the upstream gave us nothing useful.
    return { kind: "final", text: "", usage };
  }
  const msg = choice.message;
  const text = msg.content?.trim() ?? "";

  const toolCalls: ToolCall[] = [];
  for (const tc of msg.tool_calls ?? []) {
    if (tc.type !== "function") continue;
    toolCalls.push({
      id: tc.id,
      name: tc.function.name,
      args: parseToolArgs(tc.function.arguments),
    });
  }

  if (choice.finish_reason === "tool_calls" || toolCalls.length > 0) {
    return { kind: "tool_use", text, toolCalls, usage };
  }
  return { kind: "final", text, usage };
}

// Defensive arg parsing: most often this is well-formed JSON. When it isn't
// (model emitted partial JSON, a string literal, etc.) we still want the
// turn to reach the agent so it can surface a useful "invalid arguments"
// error to the model — that's what the __raw fallback is for.
function parseToolArgs(raw: string | undefined | null): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw };
  }
}

function mapUsage(u: OpenAI.CompletionUsage | undefined | null): LLMUsage | undefined {
  if (!u) return undefined;
  const out: LLMUsage = {
    inputTokens: u.prompt_tokens,
    outputTokens: u.completion_tokens,
  };
  // prompt_tokens_details.cached_tokens is the cache-read signal when present.
  const details = (u as unknown as { prompt_tokens_details?: { cached_tokens?: number } })
    .prompt_tokens_details;
  if (details && typeof details.cached_tokens === "number") {
    out.cacheReadTokens = details.cached_tokens;
  }
  return out;
}
