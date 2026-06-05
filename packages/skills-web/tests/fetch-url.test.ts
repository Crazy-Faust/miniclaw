import { describe, expect, it } from "vitest";
import type { SkillContext } from "@miniclaw/core";
import { createFetchUrlSkill, fetchUrlSkillFromEnv } from "../src/index.ts";

const stubCtx: SkillContext = {
  memory: { add: () => 0, search: () => [], listRecent: () => [] },
  audit: { logToolCall: () => {} },
  dbPath: "/dev/null",
};

function fakeFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    return await handler(url);
  }) as unknown as typeof fetch;
}

function streamBody(bytes: Uint8Array, chunkSize = 16 * 1024): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(i + chunkSize, bytes.length);
      controller.enqueue(bytes.subarray(i, end));
      i = end;
    },
  });
}

describe("createFetchUrlSkill — refusal paths (no network)", () => {
  it("refuses when no allowlist is configured (fail-closed)", async () => {
    const skill = createFetchUrlSkill({});
    const res = await skill.execute({ url: "https://example.com/" }, stubCtx);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/refused/);
    expect(res.output).toMatch(/no domain allowlist/);
  });

  it("refuses a non-allowlisted host", async () => {
    const skill = createFetchUrlSkill({ allowlist: new Set(["example.com"]) });
    const res = await skill.execute({ url: "https://evil.example.org/" }, stubCtx);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/not on the allowlist/);
  });

  it("refuses non-http(s) schemes", async () => {
    const skill = createFetchUrlSkill({ allowlist: new Set(["example.com"]) });
    const res = await skill.execute({ url: "ftp://example.com/x" }, stubCtx);
    expect(res.ok).toBe(false);
  });

  it("refuses private/loopback addresses", async () => {
    const skill = createFetchUrlSkill({ allowlist: new Set(["localhost", "127.0.0.1"]) });
    const r1 = await skill.execute({ url: "http://localhost/" }, stubCtx);
    const r2 = await skill.execute({ url: "http://127.0.0.1:9000/" }, stubCtx);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
  });
});

describe("createFetchUrlSkill — success path", () => {
  it("fetches an allowlisted URL and wraps the body in <tool_output>", async () => {
    const skill = createFetchUrlSkill({
      allowlist: new Set(["example.com"]),
      fetch: fakeFetch(() =>
        new Response("hello body", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
    });
    const res = await skill.execute({ url: "https://example.com/x" }, stubCtx);
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/status=200/);
    expect(res.output).toMatch(/content_type=text\/plain/);
    expect(res.output).toMatch(/<tool_output>[\s\S]*hello body[\s\S]*<\/tool_output>/);
  });

  it("returns ok=false for HTTP error statuses (but still includes body)", async () => {
    const skill = createFetchUrlSkill({
      allowlist: new Set(["example.com"]),
      fetch: fakeFetch(() => new Response("nope", { status: 500 })),
    });
    const res = await skill.execute({ url: "https://example.com/x" }, stubCtx);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/status=500/);
    expect(res.output).toContain("nope");
  });

  it("accepts wildcard-suffix entries in the allowlist", async () => {
    const skill = createFetchUrlSkill({
      allowlist: new Set(["*.example.com"]),
      fetch: fakeFetch(() => new Response("sub ok", { status: 200 })),
    });
    const res = await skill.execute({ url: "https://api.example.com/x" }, stubCtx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("sub ok");
  });
});

describe("createFetchUrlSkill — size cap (streamed truncation)", () => {
  it("truncates the response body at maxBytes", async () => {
    const big = new Uint8Array(300 * 1024);
    big.fill("a".charCodeAt(0));
    const skill = createFetchUrlSkill({
      allowlist: new Set(["example.com"]),
      maxBytes: 64 * 1024,
      fetch: fakeFetch(
        () =>
          new Response(streamBody(big), {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      ),
    });
    const res = await skill.execute({ url: "https://example.com/big" }, stubCtx);
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/\(truncated\)/);
    const m = /<tool_output>\n(a+)\n<\/tool_output>/.exec(res.output);
    expect(m).not.toBeNull();
    if (m && m[1]) expect(m[1].length).toBe(64 * 1024);
  });

  it("does not mark short responses as truncated", async () => {
    const skill = createFetchUrlSkill({
      allowlist: new Set(["example.com"]),
      maxBytes: 64 * 1024,
      fetch: fakeFetch(() => new Response("short", { status: 200 })),
    });
    const res = await skill.execute({ url: "https://example.com/short" }, stubCtx);
    expect(res.output).not.toMatch(/\(truncated\)/);
  });
});

describe("createFetchUrlSkill — timeout", () => {
  it("aborts the fetch when timeoutMs elapses", async () => {
    const skill = createFetchUrlSkill({
      allowlist: new Set(["example.com"]),
      timeoutMs: 50,
      fetch: ((_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("The operation was aborted");
            e.name = "AbortError";
            reject(e);
          });
        })) as unknown as typeof fetch,
    });
    const t0 = Date.now();
    const res = await skill.execute({ url: "https://example.com/slow" }, stubCtx);
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/timeout after 50ms/);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("fetchUrlSkillFromEnv", () => {
  it("reads MINICLAW_WEB_ALLOWLIST and applies it", async () => {
    const skill = fetchUrlSkillFromEnv(
      { MINICLAW_WEB_ALLOWLIST: "example.com,*.api.example.com" },
      { fetch: fakeFetch(() => new Response("ok", { status: 200 })) },
    );
    const r1 = await skill.execute({ url: "https://example.com/a" }, stubCtx);
    const r2 = await skill.execute({ url: "https://v1.api.example.com/b" }, stubCtx);
    const r3 = await skill.execute({ url: "https://elsewhere.org/c" }, stubCtx);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(false);
  });

  it("fails closed when the env var is missing", async () => {
    const skill = fetchUrlSkillFromEnv({}, { fetch: fakeFetch(() => new Response("x")) });
    const res = await skill.execute({ url: "https://example.com/" }, stubCtx);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/no domain allowlist/);
  });
});
