import { describe, expect, it } from "vitest";
import type { SkillContext } from "@miniclaw/core";
import {
  createWebSearchSkill,
  searchProviderFromEnv,
  type SearchHit,
  type WebSearchProvider,
} from "../skills/web/handler.ts";

const stubCtx: SkillContext = {
  memory: { add: () => 0, search: () => [], listRecent: () => [] },
  audit: { logToolCall: () => {} },
  dbPath: "/dev/null",
};

function fakeProvider(hits: SearchHit[]): WebSearchProvider {
  return {
    name: "fake",
    async search(_q, max) {
      return hits.slice(0, max);
    },
  };
}

describe("createWebSearchSkill", () => {
  it("returns hits as JSON inside <tool_output>", async () => {
    const skill = createWebSearchSkill({
      provider: fakeProvider([
        { title: "First", url: "https://example.com/1", snippet: "alpha" },
        { title: "Second", url: "https://example.com/2", snippet: "beta" },
      ]),
    });
    const res = await skill.execute({ query: "hello", maxResults: 5 }, stubCtx);
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/provider=fake/);
    expect(res.output).toMatch(/count=2/);
    expect(res.output).toMatch(/<tool_output>[\s\S]*"title": "First"[\s\S]*<\/tool_output>/);
  });

  it("respects maxResults from the caller (caps provider output)", async () => {
    const provider: WebSearchProvider = {
      name: "fake",
      async search(_q, max) {
        // Pretend the provider returned more than asked.
        const all: SearchHit[] = Array.from({ length: 10 }, (_, i) => ({
          title: `t${i}`,
          url: `https://example.com/${i}`,
          snippet: `s${i}`,
        }));
        return all.slice(0, max);
      },
    };
    const skill = createWebSearchSkill({ provider });
    const res = await skill.execute({ query: "x", maxResults: 3 }, stubCtx);
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/count=3/);
  });

  it("surfaces provider errors as failure", async () => {
    const skill = createWebSearchSkill({
      provider: {
        name: "broken",
        async search() {
          throw new Error("upstream 503");
        },
      },
    });
    const res = await skill.execute({ query: "x", maxResults: 5 }, stubCtx);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/search error: upstream 503/);
  });

  it("aborts when the provider exceeds timeoutMs", async () => {
    const skill = createWebSearchSkill({
      timeoutMs: 50,
      provider: {
        name: "slow",
        search: (_q, _max, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            });
          }),
      },
    });
    const res = await skill.execute({ query: "x", maxResults: 5 }, stubCtx);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/timeout after 50ms/);
  });
});

describe("searchProviderFromEnv", () => {
  it("returns null when MINICLAW_SEARCH_API_KEY is unset (gates registration)", () => {
    expect(searchProviderFromEnv({})).toBeNull();
  });

  it("returns a Brave provider when the key is set", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const fakeFetch = (async (input: unknown, init?: RequestInit) => {
      seenUrl = typeof input === "string" ? input : String(input);
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
          web: {
            results: [
              { title: "Brave Hit", url: "https://example.com/b", description: "snippet body" },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const provider = searchProviderFromEnv({ MINICLAW_SEARCH_API_KEY: "test-key" }, fakeFetch);
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe("brave");

    const ctrl = new AbortController();
    const hits = await provider!.search("hello", 3, ctrl.signal);
    expect(hits).toEqual([
      { title: "Brave Hit", url: "https://example.com/b", snippet: "snippet body" },
    ]);
    expect(seenUrl).toMatch(/api\.search\.brave\.com/);
    expect(seenUrl).toMatch(/q=hello/);
    expect(seenUrl).toMatch(/count=3/);
    expect(seenHeaders["x-subscription-token"]).toBe("test-key");
  });

  it("Brave provider throws on non-2xx responses", async () => {
    const fakeFetch = (async () =>
      new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    const provider = searchProviderFromEnv({ MINICLAW_SEARCH_API_KEY: "k" }, fakeFetch);
    await expect(provider!.search("q", 1, new AbortController().signal)).rejects.toThrow(/429/);
  });
});
