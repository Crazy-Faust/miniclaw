import { describe, expect, it } from "vitest";
import type { Message } from "@miniclaw/core";
import { toGeminiContents, toGeminiContentsAll } from "../src/mapping.ts";

describe("toGeminiContents", () => {
  it("maps a user text message to role:user with a text part", () => {
    const m: Message = { role: "user", content: "hello" };
    expect(toGeminiContents(m)).toEqual([
      { role: "user", parts: [{ text: "hello" }] },
    ]);
  });

  it("maps an assistant text-only message to role:model with a text part", () => {
    const m: Message = { role: "assistant", content: "hi" };
    expect(toGeminiContents(m)).toEqual([
      { role: "model", parts: [{ text: "hi" }] },
    ]);
  });

  it("emits both text and functionCall parts for a tool_use turn", () => {
    const m: Message = {
      role: "assistant",
      content: "thinking",
      toolCalls: [{ id: "id1", name: "shell", args: { bin: "ls" } }],
    };
    const out = toGeminiContents(m);
    expect(out).toEqual([
      {
        role: "model",
        parts: [
          { text: "thinking" },
          { functionCall: { name: "shell", args: { bin: "ls" } } },
        ],
      },
    ]);
  });

  it("falls back to an empty text part when an assistant turn has no parts", () => {
    const m: Message = { role: "assistant", content: "" };
    expect(toGeminiContents(m)).toEqual([
      { role: "model", parts: [{ text: "" }] },
    ]);
  });

  it("normalizes missing tool args to an empty object", () => {
    const m: Message = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "id1", name: "x", args: undefined }],
    };
    const part = toGeminiContents(m)[0]!.parts[0]!;
    expect(part.functionCall).toEqual({ name: "x", args: {} });
  });

  it("maps tool results to role:user functionResponse parts keyed by name", () => {
    const m: Message = {
      role: "tool",
      results: [
        { toolCallId: "c1", toolName: "shell", content: "ok", isError: false },
        { toolCallId: "c2", toolName: "shell", content: "boom", isError: true },
      ],
    };
    const out = toGeminiContents(m);
    expect(out).toEqual([
      {
        role: "user",
        parts: [
          { functionResponse: { name: "shell", response: { content: "ok" } } },
          { functionResponse: { name: "shell", response: { error: "boom" } } },
        ],
      },
    ]);
  });
});

describe("toGeminiContentsAll", () => {
  it("flattens a mixed conversation in order", () => {
    const conv: Message[] = [
      { role: "user", content: "do X" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "shell", args: { bin: "ls" } }],
      },
      {
        role: "tool",
        results: [{ toolCallId: "c1", toolName: "shell", content: "out", isError: false }],
      },
      { role: "assistant", content: "done" },
    ];
    const flat = toGeminiContentsAll(conv);
    expect(flat.map((c) => c.role)).toEqual(["user", "model", "user", "model"]);
  });
});
