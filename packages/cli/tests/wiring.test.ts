import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "@miniclaw/llm-anthropic";
import { GeminiProvider } from "@miniclaw/llm-gemini";
import { OpenAIProvider } from "@miniclaw/llm-openai";

import { buildLLM, buildSmallLLM } from "../src/llm.ts";
import { buildToolGuard, describeSecurityMode } from "../src/security.ts";
import { buildRegistry } from "../src/skills.ts";
import type { Config } from "../src/config.ts";

// CLI is the only place where every concrete implementation is wired
// together. These tests assert that composition happens correctly without
// booting the REPL.

describe("buildRegistry", () => {
  it("registers every dependency-free built-in skill (no provider key set)", () => {
    const r = buildRegistry({});
    const names = r.list().map((s) => s.name).sort();
    expect(names).toEqual([
      "apply_patch",
      "fetch_url",
      "list_directory",
      "read_file",
      "search_memory",
      "shell",
      "sql_query",
      "write_file",
      "write_memory",
    ]);
  });

  it("adds web_search only when MINICLAW_SEARCH_API_KEY is set", () => {
    const without = buildRegistry({});
    const withKey = buildRegistry({ MINICLAW_SEARCH_API_KEY: "test-key" });
    expect(without.list().map((s) => s.name)).not.toContain("web_search");
    expect(withKey.list().map((s) => s.name)).toContain("web_search");
  });

  it("produces a valid tool spec per skill (Anthropic-shaped JSON Schema object)", () => {
    const specs = buildRegistry({}).toolSpecs();
    expect(specs).toHaveLength(9);
    for (const s of specs) {
      expect(typeof s.name).toBe("string");
      expect(typeof s.description).toBe("string");
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("two registries are independent instances", () => {
    const a = buildRegistry({});
    const b = buildRegistry({});
    expect(a).not.toBe(b);
    expect(a.list().length).toBe(b.list().length);
  });
});

function fakeConfig(over: Partial<Config>): Config {
  return {
    home: "/tmp/x",
    dbPath: "/tmp/x.db",
    provider: "anthropic",
    apiKey: "sk-test",
    model: "test-model",
    workspaceRoot: "/tmp/x",
    securityMode: "medium",
    ...over,
  };
}

describe("buildLLM", () => {
  it("returns an AnthropicProvider for provider=anthropic", () => {
    const llm = buildLLM(fakeConfig({ provider: "anthropic" }));
    expect(llm).toBeInstanceOf(AnthropicProvider);
  });

  it("returns an OpenAIProvider for provider=openai (honoring baseURL)", () => {
    const llm = buildLLM(
      fakeConfig({ provider: "openai", baseURL: "http://localhost:11434/v1" }),
    );
    expect(llm).toBeInstanceOf(OpenAIProvider);
  });

  it("returns a GeminiProvider for provider=gemini", () => {
    const llm = buildLLM(fakeConfig({ provider: "gemini" }));
    expect(llm).toBeInstanceOf(GeminiProvider);
  });

  it("returns undefined when no small LLM is configured", () => {
    expect(buildSmallLLM(fakeConfig({}))).toBeUndefined();
  });

  it("builds the configured small LLM with the same provider interface", () => {
    const llm = buildSmallLLM(
      fakeConfig({
        smallLLM: {
          provider: "openai",
          apiKey: "sk-small",
          model: "small-model",
          baseURL: "http://localhost:11434/v1",
        },
      }),
    );
    expect(llm).toBeInstanceOf(OpenAIProvider);
  });
});

describe("buildToolGuard", () => {
  it("does not build an LLM guard for off or medium security", () => {
    expect(buildToolGuard(fakeConfig({ securityMode: "off" }), undefined)).toBeUndefined();
    expect(buildToolGuard(fakeConfig({ securityMode: "medium" }), undefined)).toBeUndefined();
    expect(describeSecurityMode(fakeConfig({ securityMode: "medium" }))).toBe("medium");
  });

  it("requires a small LLM in high security mode", () => {
    expect(() => buildToolGuard(fakeConfig({ securityMode: "high" }), undefined)).toThrow(
      /MINICLAW_SMALL_PROVIDER/,
    );
  });

  it("builds a high-security guard from the small LLM", async () => {
    const small = {
      async chat() {
        return { kind: "final" as const, text: '{ "allowed": true, "reason": "ok" }' };
      },
    };
    const guard = buildToolGuard(fakeConfig({ securityMode: "high" }), small);
    await expect(
      guard!({
        userMessage: "list files",
        call: { name: "list_directory", args: { path: "." } },
        skill: { name: "list_directory", description: "list directory" },
      }),
    ).resolves.toEqual({ allow: true });
    expect(describeSecurityMode(fakeConfig({ securityMode: "high" }))).toBe(
      "high (small-LLM tool gate)",
    );
  });
});
