import { GoogleGenAI } from "@google/genai";
import type {
  AssistantTurn,
  LLMProvider,
  LLMUsage,
  Message,
  ToolCall,
  ToolSpec,
} from "@miniclaw/core";
import { toGeminiContentsAll } from "./mapping.ts";

// Structural subset of the SDK we touch. The real client returns rich
// objects; tests inject a fake whose generateContent and generateContentStream
// produce just the fields our provider reads.
export interface GeminiGenerationResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: { name?: string; args?: Record<string, unknown> };
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

export interface GeminiModelsClient {
  generateContent(params: unknown): Promise<GeminiGenerationResponse>;
  generateContentStream(params: unknown): Promise<AsyncIterable<GeminiGenerationResponse>>;
}

export interface GeminiProviderOpts {
  apiKey?: string;
  model: string;
  maxTokens?: number;
  client?: { models: GeminiModelsClient };
}

export class GeminiProvider implements LLMProvider {
  private readonly client: { models: GeminiModelsClient };
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: GeminiProviderOpts) {
    if (opts.client) {
      this.client = opts.client;
    } else {
      if (!opts.apiKey) throw new Error("GeminiProvider: apiKey or client required");
      this.client = new GoogleGenAI({ apiKey: opts.apiKey }) as unknown as {
        models: GeminiModelsClient;
      };
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
    const tools =
      opts.tools.length > 0
        ? [
            {
              functionDeclarations: opts.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.inputSchema as Record<string, unknown>,
              })),
            },
          ]
        : undefined;

    const params = {
      model: this.model,
      contents: toGeminiContentsAll(opts.messages),
      config: {
        systemInstruction: opts.system,
        maxOutputTokens: this.maxTokens,
        tools,
      },
    };

    if (opts.onToken) {
      return await this.streamingChat(params, opts.onToken);
    }
    const res = await this.client.models.generateContent(params);
    return assistantTurnFromResponse(res);
  }

  private async streamingChat(
    params: unknown,
    onToken: (delta: string) => void,
  ): Promise<AssistantTurn> {
    const stream = await this.client.models.generateContentStream(params);

    let assembledText = "";
    const toolCalls: ToolCall[] = [];
    let callSeq = 0;
    let finishReason: string | undefined;
    let usage: LLMUsage | undefined;

    for await (const chunk of stream) {
      if (chunk.usageMetadata) usage = mapUsage(chunk.usageMetadata);
      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      const parts = candidate?.content?.parts ?? [];
      for (const p of parts) {
        if (typeof p.text === "string" && p.text.length > 0) {
          assembledText += p.text;
          try {
            onToken(p.text);
          } catch {
            // Don't let a misbehaving sink kill the stream.
          }
        } else if (p.functionCall) {
          toolCalls.push({
            id: `gemini-${callSeq++}`,
            name: p.functionCall.name ?? "",
            args: p.functionCall.args ?? {},
          });
        }
      }
    }

    const text = assembledText.trim();
    // Gemini's stream sometimes ends with finishReason=STOP even when a
    // functionCall part was emitted — trust the presence of toolCalls.
    if (toolCalls.length > 0 || finishReason === "TOOL_CODE") {
      return { kind: "tool_use", text, toolCalls, usage };
    }
    return { kind: "final", text, usage };
  }
}

function assistantTurnFromResponse(res: GeminiGenerationResponse): AssistantTurn {
  const candidate = res.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  let callSeq = 0;
  for (const p of parts) {
    if (typeof p.text === "string" && p.text.length > 0) {
      textParts.push(p.text);
    } else if (p.functionCall) {
      // Gemini does not return per-call IDs; synthesize a stable id so the
      // agent can pair calls with results. (Our mapper writes results back
      // keyed by name, not id, so this id is internal-only.)
      toolCalls.push({
        id: `gemini-${callSeq++}`,
        name: p.functionCall.name ?? "",
        args: p.functionCall.args ?? {},
      });
    }
  }
  const text = textParts.join("\n").trim();
  const usage = mapUsage(res.usageMetadata);

  if (toolCalls.length > 0) {
    return { kind: "tool_use", text, toolCalls, usage };
  }
  return { kind: "final", text, usage };
}

function mapUsage(u: GeminiGenerationResponse["usageMetadata"]): LLMUsage | undefined {
  if (!u) return undefined;
  const out: LLMUsage = {
    inputTokens: u.promptTokenCount,
    outputTokens: u.candidatesTokenCount,
  };
  if (typeof u.cachedContentTokenCount === "number") {
    out.cacheReadTokens = u.cachedContentTokenCount;
  }
  return out;
}
