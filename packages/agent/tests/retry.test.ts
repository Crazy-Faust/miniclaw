import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AssistantTurn,
  type LLMProvider,
  SkillRegistry,
} from "@miniclaw/core";
import { WindowedContextManager } from "@miniclaw/context-windowed";
import { SqliteStore } from "@miniclaw/memory-sqlite";

import { Agent, defaultIsTransient, type AgentRetryOptions } from "../src/index.ts";

// A provider that fails N times with a configurable error, then returns
// a scripted turn. Records every attempt so tests can assert call count.
class FlakeyLLM implements LLMProvider {
  attempts = 0;
  constructor(
    private readonly failuresBeforeSuccess: number,
    private readonly errorFactory: () => unknown,
    private readonly successTurn: AssistantTurn = { kind: "final", text: "ok" },
  ) {}
  async chat(): Promise<AssistantTurn> {
    this.attempts++;
    if (this.attempts <= this.failuresBeforeSuccess) {
      throw this.errorFactory();
    }
    return this.successTurn;
  }
}

function buildAgent(store: SqliteStore, llm: LLMProvider, retry?: AgentRetryOptions) {
  const registry = new SkillRegistry();
  const convId = store.newConversation();
  const context = new WindowedContextManager({
    memory: store, conversations: store, conversationId: convId,
  });
  return new Agent({
    llm, registry, context, memory: store, audit: store, dbPath: store.path, retry,
  });
}

describe("defaultIsTransient", () => {
  it("treats 429 / 500 / 502 / 503 / 504 status codes as transient", () => {
    for (const code of [429, 500, 502, 503, 504, 408]) {
      expect(defaultIsTransient({ status: code })).toBe(true);
      expect(defaultIsTransient({ statusCode: code })).toBe(true);
    }
  });

  it("treats 4xx (non-429/408) as non-transient", () => {
    for (const code of [400, 401, 403, 404, 422]) {
      expect(defaultIsTransient({ status: code })).toBe(false);
    }
  });

  it("treats rate-limit / overload / 5xx messages as transient", () => {
    expect(defaultIsTransient(new Error("HTTP 429 rate limited"))).toBe(true);
    expect(defaultIsTransient(new Error("overloaded_error from upstream"))).toBe(true);
    expect(defaultIsTransient(new Error("500 Internal Server Error"))).toBe(true);
    expect(defaultIsTransient(new Error("Service Unavailable"))).toBe(true);
    expect(defaultIsTransient(new Error("ECONNRESET"))).toBe(true);
  });

  it("treats arbitrary application errors as non-transient", () => {
    expect(defaultIsTransient(new Error("invalid api key"))).toBe(false);
    expect(defaultIsTransient(new Error("model not found"))).toBe(false);
    expect(defaultIsTransient(null)).toBe(false);
    expect(defaultIsTransient(undefined)).toBe(false);
  });
});

describe("Agent — retry/backoff on transient provider errors", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-retry-"));
    store = new SqliteStore(join(dir, "test.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("retries a 429 once and succeeds on the second attempt", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const llm = new FlakeyLLM(1, () => Object.assign(new Error("HTTP 429"), { status: 429 }));
    const agent = buildAgent(store, llm, { maxAttempts: 3, sleep, baseDelayMs: 10, jitter: 0 });

    const trace = await agent.runTurn("hi");
    expect(trace.finalText).toBe("ok");
    expect(llm.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    // baseDelayMs * 2^0 with jitter=0 = 10.
    expect(sleep.mock.calls[0]?.[0]).toBe(10);
  });

  it("retries a 503, then a 502, then succeeds (backoff grows exponentially)", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    let n = 0;
    const llm: LLMProvider = {
      async chat() {
        n++;
        if (n === 1) throw Object.assign(new Error("503"), { status: 503 });
        if (n === 2) throw Object.assign(new Error("502 bad gateway"), { status: 502 });
        return { kind: "final", text: "third time" };
      },
    };
    const agent = buildAgent(store, llm, { maxAttempts: 5, sleep, baseDelayMs: 10, jitter: 0 });

    const trace = await agent.runTurn("hi");
    expect(trace.finalText).toBe("third time");
    expect(n).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    // Exponential schedule: 10, 20.
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 20]);
  });

  it("gives up after maxAttempts and rethrows the last transient error", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const llm = new FlakeyLLM(99, () => Object.assign(new Error("rate limited"), { status: 429 }));
    const agent = buildAgent(store, llm, { maxAttempts: 3, sleep, baseDelayMs: 5, jitter: 0 });

    await expect(agent.runTurn("hi")).rejects.toThrow(/rate limited/);
    expect(llm.attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2); // sleep happens BETWEEN attempts, not after the last
  });

  it("does NOT retry a non-transient error (e.g. 400) and gives up immediately", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const llm = new FlakeyLLM(99, () => Object.assign(new Error("invalid api key"), { status: 401 }));
    const agent = buildAgent(store, llm, { maxAttempts: 5, sleep, baseDelayMs: 5, jitter: 0 });

    await expect(agent.runTurn("hi")).rejects.toThrow(/invalid api key/);
    expect(llm.attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("honors a custom isTransient classifier", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const llm = new FlakeyLLM(1, () => new Error("custom-transient-marker"));
    const agent = buildAgent(store, llm, {
      maxAttempts: 3,
      sleep,
      baseDelayMs: 5,
      jitter: 0,
      isTransient: (err) => /custom-transient-marker/.test((err as Error).message),
    });

    const trace = await agent.runTurn("hi");
    expect(trace.finalText).toBe("ok");
    expect(llm.attempts).toBe(2);
  });

  it("maxAttempts=1 disables retry (single shot)", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const llm = new FlakeyLLM(99, () => Object.assign(new Error("429"), { status: 429 }));
    const agent = buildAgent(store, llm, { maxAttempts: 1, sleep, baseDelayMs: 5 });

    await expect(agent.runTurn("hi")).rejects.toThrow();
    expect(llm.attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
