import { describe, expect, it } from "vitest";
import {
  withLLMUsageContext,
  type AssistantTurn,
  type LLMProvider,
  type LLMUsageRecord,
} from "@miniclaw/core";
import { trackLLMUsage } from "../src/llm-usage.ts";

describe("trackLLMUsage", () => {
  it("records successful provider usage", async () => {
    const records: LLMUsageRecord[] = [];
    const llm: LLMProvider = {
      async chat(): Promise<AssistantTurn> {
        return {
          kind: "final",
          text: "ok",
          usage: { inputTokens: 3, outputTokens: 2 },
        };
      },
    };

    const wrapped = trackLLMUsage(
      llm,
      { recordLLMUsage: (record) => records.push(record) },
      { provider: "openai", model: "gpt-test", role: "primary" },
    );

    await expect(wrapped.chat({ system: "", messages: [], tools: [] })).resolves.toMatchObject({
      kind: "final",
      text: "ok",
    });
    expect(records).toEqual([
      {
        provider: "openai",
        model: "gpt-test",
        role: "primary",
        kind: "final",
        usage: { inputTokens: 3, outputTokens: 2 },
      },
    ]);
  });

  it("records failed provider calls without swallowing the error", async () => {
    const records: LLMUsageRecord[] = [];
    const llm: LLMProvider = {
      async chat(): Promise<AssistantTurn> {
        throw new Error("rate limited");
      },
    };

    const wrapped = trackLLMUsage(
      llm,
      { recordLLMUsage: (record) => records.push(record) },
      { provider: "anthropic", model: "claude-test", role: "small" },
    );

    await expect(wrapped.chat({ system: "", messages: [], tools: [] })).rejects.toThrow("rate limited");
    expect(records).toEqual([
      {
        provider: "anthropic",
        model: "claude-test",
        role: "small",
        kind: "error",
      },
    ]);
  });

  it("records scoped usage context when present", async () => {
    const records: LLMUsageRecord[] = [];
    const llm: LLMProvider = {
      async chat(): Promise<AssistantTurn> {
        return { kind: "final", text: "ok" };
      },
    };
    const wrapped = trackLLMUsage(
      llm,
      { recordLLMUsage: (record) => records.push(record) },
      { provider: "openai", model: "gpt-test", role: "small" },
    );

    await withLLMUsageContext({
      taskKind: "cron",
      taskName: "cron #7",
      channel: "cron:7:123",
      sessionId: "sess-7",
      conversationId: 99,
      component: "agent",
    }, () => wrapped.chat({ system: "", messages: [], tools: [] }));

    expect(records[0]).toMatchObject({
      provider: "openai",
      model: "gpt-test",
      role: "small",
      kind: "final",
      context: {
        taskKind: "cron",
        taskName: "cron #7",
        channel: "cron:7:123",
        sessionId: "sess-7",
        conversationId: 99,
        component: "agent",
      },
    });
  });
});
