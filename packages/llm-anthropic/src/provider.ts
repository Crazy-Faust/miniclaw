import Anthropic from "@anthropic-ai/sdk";
import type {
  AssistantTurn,
  LLMProvider,
  LLMUsage,
  Message,
  ToolCall,
  ToolSpec,
} from "@miniclaw/core";
import { toAnthropicMessage } from "./mapping.ts";

// Structural subset of Anthropic.Messages we actually call. Tests inject a
// minimal fake; production uses the real SDK.
export interface AnthropicMessagesClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  stream(params: Anthropic.MessageCreateParamsNonStreaming): {
    on(event: "text", listener: (text: string) => void): unknown;
    finalMessage(): Promise<Anthropic.Message>;
  };
}

export interface AnthropicProviderOpts {
  apiKey?: string;
  model: string;
  maxTokens?: number;
  /** Inject a pre-built SDK client (or a stub in tests). */
  client?: { messages: AnthropicMessagesClient };
}

export class AnthropicProvider implements LLMProvider {
  private readonly client: { messages: AnthropicMessagesClient };
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: AnthropicProviderOpts) {
    if (opts.client) {
      this.client = opts.client;
    } else {
      if (!opts.apiKey) throw new Error("AnthropicProvider: apiKey or client required");
      this.client = new Anthropic({ apiKey: opts.apiKey });
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
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: opts.system,
      tools: opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
      messages: opts.messages.map(toAnthropicMessage),
    };

    let res: Anthropic.Message;
    if (opts.onToken) {
      // Streaming path — bypass collecting to give the harness deltas live.
      // We still wait for finalMessage() so the resolved shape is identical
      // to the non-streaming response (stop_reason, content blocks, usage).
      const stream = this.client.messages.stream(params);
      stream.on("text", (text: string) => {
        try {
          opts.onToken!(text);
        } catch {
          // A misbehaving sink must not poison the rest of the stream.
        }
      });
      res = await stream.finalMessage();
    } else {
      res = await this.client.messages.create(params);
    }

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of res.content) {
      if (block.type === "text") textParts.push(block.text);
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, args: block.input });
      }
    }
    const text = textParts.join("\n").trim();
    const usage = mapUsage(res.usage);

    if (res.stop_reason === "tool_use" || toolCalls.length > 0) {
      return { kind: "tool_use", text, toolCalls, usage };
    }
    return { kind: "final", text, usage };
  }
}

function mapUsage(u: Anthropic.Message["usage"] | undefined): LLMUsage | undefined {
  if (!u) return undefined;
  const out: LLMUsage = {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
  };
  // Cache fields aren't on every SDK version; read them defensively so a
  // pinned older SDK still typechecks.
  const ext = u as unknown as Record<string, unknown>;
  if (typeof ext.cache_read_input_tokens === "number") {
    out.cacheReadTokens = ext.cache_read_input_tokens;
  }
  if (typeof ext.cache_creation_input_tokens === "number") {
    out.cacheWriteTokens = ext.cache_creation_input_tokens;
  }
  return out;
}
