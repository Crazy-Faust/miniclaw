import { describe, expect, it } from "vitest";
import type { Message } from "@miniclaw/core";
import { toOpenAIMessages, toOpenAIMessagesAll } from "../src/mapping.ts";

describe("toOpenAIMessages", () => {
  it("maps a user text message", () => {
    const m: Message = { role: "user", content: "hello" };
    expect(toOpenAIMessages(m)).toEqual([{ role: "user", content: "hello" }]);
  });

  it("maps an assistant text-only message with content as a string", () => {
    const m: Message = { role: "assistant", content: "hi" };
    expect(toOpenAIMessages(m)).toEqual([
      { role: "assistant", content: "hi" },
    ]);
  });

  it("sets assistant content to null when empty so OpenAI accepts pure tool-call turns", () => {
    const m: Message = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "shell", args: { bin: "ls" } }],
    };
    const out = toOpenAIMessages(m);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ role: "assistant", content: null });
  });

  it("serializes tool args to a JSON string under function.arguments", () => {
    const m: Message = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "shell", args: { bin: "ls", args: ["-la"] } }],
    };
    const out = toOpenAIMessages(m) as Array<{
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    }>;
    const tc = out[0]!.tool_calls![0]!;
    expect(tc.id).toBe("c1");
    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe("shell");
    expect(JSON.parse(tc.function.arguments)).toEqual({ bin: "ls", args: ["-la"] });
  });

  it("normalizes missing args to an empty JSON object string", () => {
    const m: Message = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "x", args: undefined }],
    };
    const out = toOpenAIMessages(m) as Array<{
      tool_calls: Array<{ function: { arguments: string } }>;
    }>;
    expect(out[0]!.tool_calls[0]!.function.arguments).toBe("{}");
  });

  it("fans tool results out into one role:tool message each", () => {
    const m: Message = {
      role: "tool",
      results: [
        { toolCallId: "c1", toolName: "x", content: "ok", isError: false },
        { toolCallId: "c2", toolName: "x", content: "boom", isError: true },
      ],
    };
    const out = toOpenAIMessages(m);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: "tool", tool_call_id: "c1", content: "ok" });
    expect(out[1]).toMatchObject({
      role: "tool",
      tool_call_id: "c2",
      content: "[error] boom",
    });
  });
});

describe("toOpenAIMessagesAll", () => {
  it("flattens a mixed conversation including a tool-results aggregate", () => {
    const conv: Message[] = [
      { role: "user", content: "do X" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "shell", args: { bin: "ls" } }],
      },
      {
        role: "tool",
        results: [
          { toolCallId: "c1", toolName: "shell", content: "out", isError: false },
        ],
      },
      { role: "assistant", content: "done" },
    ];
    const flat = toOpenAIMessagesAll(conv);
    expect(flat.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });
});
