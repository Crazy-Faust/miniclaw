import type OpenAI from "openai";
import type { Message } from "@miniclaw/core";

// OpenAI's tool flow differs from Anthropic's in two ways:
//   1. Each tool RESULT is its own `role: "tool"` message (not a single
//      user message with multiple result blocks).
//   2. tool_use sits on the assistant message as `tool_calls[]` with the
//      args as a JSON string under `function.arguments`.

// Our `Message` is a single tool-results aggregate, so when mapping to
// OpenAI we may emit MULTIPLE messages from one input. Hence the array
// return + flatMap at the call site.
export function toOpenAIMessages(
  m: Message,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  if (m.role === "user") {
    return [{ role: "user", content: m.content }];
  }
  if (m.role === "assistant") {
    const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: m.content || null,
    };
    if (m.toolCalls && m.toolCalls.length > 0) {
      msg.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.args ?? {}),
        },
      }));
    }
    return [msg];
  }
  // tool: fan out — one "tool" message per result
  return m.results.map<OpenAI.Chat.Completions.ChatCompletionToolMessageParam>((r) => ({
    role: "tool",
    tool_call_id: r.toolCallId,
    // is_error has no first-class slot in OpenAI's API; prefix the text so
    // the model still gets the signal.
    content: r.isError ? `[error] ${r.content}` : r.content,
  }));
}

export function toOpenAIMessagesAll(
  messages: Message[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.flatMap(toOpenAIMessages);
}
