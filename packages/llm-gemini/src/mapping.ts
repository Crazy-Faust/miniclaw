import type { Message } from "@miniclaw/core";

// Gemini calls tool calls "functionCall" and tool results "functionResponse".
// Both live as `parts` on a `content` entry. The `role` is "user" for human
// turns AND for function responses (Gemini's convention); "model" for the
// assistant. Function responses are keyed by NAME, not by call ID — that's
// why we require `toolName` on ToolResultPart.

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export function toGeminiContents(m: Message): GeminiContent[] {
  if (m.role === "user") {
    return [{ role: "user", parts: [{ text: m.content }] }];
  }
  if (m.role === "assistant") {
    const parts: GeminiPart[] = [];
    if (m.content) parts.push({ text: m.content });
    for (const tc of m.toolCalls ?? []) {
      parts.push({
        functionCall: {
          name: tc.name,
          args: (tc.args ?? {}) as Record<string, unknown>,
        },
      });
    }
    // Gemini rejects model turns with zero parts. Insert an empty text part
    // as a fallback so the conversation remains well-formed.
    if (parts.length === 0) parts.push({ text: "" });
    return [{ role: "model", parts }];
  }
  // tool: emit one "user" content with a functionResponse part per result.
  return [
    {
      role: "user",
      parts: m.results.map((r) => ({
        functionResponse: {
          name: r.toolName,
          response: r.isError ? { error: r.content } : { content: r.content },
        },
      })),
    },
  ];
}

export function toGeminiContentsAll(messages: Message[]): GeminiContent[] {
  return messages.flatMap(toGeminiContents);
}
