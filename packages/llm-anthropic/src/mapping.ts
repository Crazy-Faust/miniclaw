import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@miniclaw/core";

// Exported so the mapping can be tested without invoking the network.
type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export function toAnthropicMessage(m: Message): Anthropic.MessageParam {
  if (m.role === "user") return { role: "user", content: m.content };
  if (m.role === "assistant") {
    const blocks: AssistantBlock[] = [];
    if (m.content) blocks.push({ type: "text", text: m.content });
    for (const tc of m.toolCalls ?? []) {
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.name,
        input: (tc.args ?? {}) as Record<string, unknown>,
      });
    }
    return { role: "assistant", content: blocks };
  }
  return {
    role: "user",
    content: m.results.map((r) => ({
      type: "tool_result" as const,
      tool_use_id: r.toolCallId,
      content: r.content,
      is_error: r.isError,
    })),
  };
}
