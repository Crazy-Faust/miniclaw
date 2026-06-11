import { describe, expect, it } from "vitest";
import type { AssistantTurn, LLMProvider, Message, ToolSpec } from "@miniclaw/core";
import {
  buildToolSecurityPrompt,
  createLLMToolSecurityGuard,
  parseToolSecurityDecision,
} from "../src/index.ts";

class RecordingPolicyLLM implements LLMProvider {
  calls: Array<{ system: string; messages: Message[]; tools: ToolSpec[] }> = [];
  constructor(private readonly turn: AssistantTurn) {}
  async chat(opts: { system: string; messages: Message[]; tools: ToolSpec[] }): Promise<AssistantTurn> {
    this.calls.push(opts);
    return this.turn;
  }
}

describe("tool security guard", () => {
  it("allows when the policy model returns allowed=true", async () => {
    const llm = new RecordingPolicyLLM({
      kind: "final",
      text: '{ "allowed": true, "reason": "matches request" }',
    });
    const guard = createLLMToolSecurityGuard(llm);

    const decision = await guard({
      userMessage: "list files",
      call: { name: "list_directory", args: { path: "." } },
      skill: { name: "list_directory", description: "list directory entries" },
    });

    expect(decision).toEqual({ allow: true });
    const firstMessage = llm.calls[0]!.messages[0] as { role: "user"; content: string };
    const prompt = firstMessage.content;
    expect(prompt).toContain("Original user request:\nlist files");
    expect(prompt).toContain("name: list_directory");
    expect(prompt).toContain('"path": "."');
    expect(llm.calls[0]!.tools).toEqual([]);
  });

  it("denies when the policy model returns allowed=false", async () => {
    const llm = new RecordingPolicyLLM({
      kind: "final",
      text: '{ "allowed": false, "reason": "delete does not match list request" }',
    });
    const guard = createLLMToolSecurityGuard(llm);

    const decision = await guard({
      userMessage: "list files",
      call: { name: "delete_file", args: { path: "a.txt" } },
      skill: { name: "delete_file", description: "delete a file" },
    });

    expect(decision).toEqual({
      allow: false,
      reason: "security denied delete_file: delete does not match list request",
    });
  });

  it("parses fenced JSON responses", () => {
    expect(parseToolSecurityDecision('```json\n{ "allowed": false, "reason": "no" }\n```')).toEqual({
      allowed: false,
      reason: "no",
    });
  });

  it("builds prompts without omitting tool description", () => {
    expect(
      buildToolSecurityPrompt({
        userMessage: "remember x",
        toolName: "write_memory",
        toolDescription: "write memory",
        toolArgs: "{}",
      }),
    ).toContain("description: write memory");
  });
});
