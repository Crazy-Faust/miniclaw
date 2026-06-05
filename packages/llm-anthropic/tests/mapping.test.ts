import { describe, expect, it } from "vitest";
import type { Message } from "@miniclaw/core";
import { toAnthropicMessage } from "../src/mapping.ts";

describe("toAnthropicMessage", () => {
  it("maps a user text message", () => {
    const m: Message = { role: "user", content: "hello" };
    expect(toAnthropicMessage(m)).toEqual({ role: "user", content: "hello" });
  });

  it("maps an assistant text-only message to a single text block", () => {
    const m: Message = { role: "assistant", content: "hi" };
    expect(toAnthropicMessage(m)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
    });
  });

  it("maps an assistant tool_use turn with text+tool blocks", () => {
    const m: Message = {
      role: "assistant",
      content: "thinking",
      toolCalls: [{ id: "abc", name: "shell", args: { bin: "ls", args: ["-la"] } }],
    };
    const result = toAnthropicMessage(m);
    expect(result.role).toBe("assistant");
    expect(Array.isArray(result.content)).toBe(true);
    const blocks = result.content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "text", text: "thinking" });
    expect(blocks[1]).toMatchObject({
      type: "tool_use",
      id: "abc",
      name: "shell",
      input: { bin: "ls", args: ["-la"] },
    });
  });

  it("emits only tool_use blocks when assistant text is empty", () => {
    const m: Message = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "id1", name: "x", args: { y: 1 } }],
    };
    const result = toAnthropicMessage(m);
    const blocks = result.content as unknown as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "tool_use", id: "id1", name: "x" });
  });

  it("normalizes missing args to an empty object", () => {
    const m: Message = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "id1", name: "x", args: undefined }],
    };
    const blocks = toAnthropicMessage(m).content as unknown as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({ input: {} });
  });

  it("maps a tool-results message to a user message with tool_result blocks", () => {
    const m: Message = {
      role: "tool",
      results: [
        { toolCallId: "id1", toolName: "x", content: "ok", isError: false },
        { toolCallId: "id2", toolName: "x", content: "boom", isError: true },
      ],
    };
    const result = toAnthropicMessage(m);
    expect(result.role).toBe("user");
    const blocks = result.content as unknown as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "id1",
      content: "ok",
      is_error: false,
    });
    expect(blocks[1]).toMatchObject({
      type: "tool_result",
      tool_use_id: "id2",
      is_error: true,
    });
  });
});
