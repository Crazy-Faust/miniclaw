import { describe, expect, it } from "vitest";
import type { SkillContext } from "@miniclaw/core";
import { createFetchUrlSkill } from "../skills/web/handler.ts";

const stubCtx: SkillContext = {
  memory: { add: () => 0, search: () => [], listRecent: () => [] },
  audit: { logToolCall: () => {} },
  dbPath: "/dev/null",
};

// VULN-11: redirect validation
describe("createFetchUrlSkill — redirect validation (VULN-11)", () => {
  it("blocks redirects to private/internal hosts", async () => {
    let callCount = 0;
    const skill = createFetchUrlSkill({
      allowlist: new Set(["example.com"]),
      fetch: (async (input: unknown) => {
        callCount++;
        if (callCount === 1) {
          // First call: redirect to internal metadata service
          return new Response("", {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data/" },
          });
        }
        return new Response("should not reach", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const res = await skill.execute({ url: "https://example.com/redirect" }, stubCtx);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/refused.*redirect/i);
    expect(res.output).toMatch(/private|loopback/i);
  });

  it("blocks redirects to non-allowlisted hosts", async () => {
    let callCount = 0;
    const skill = createFetchUrlSkill({
      allowlist: new Set(["example.com"]),
      fetch: (async (input: unknown) => {
        callCount++;
        if (callCount === 1) {
          return new Response("", {
            status: 302,
            headers: { location: "https://evil.example.org/steal" },
          });
        }
        return new Response("should not reach", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const res = await skill.execute({ url: "https://example.com/redirect" }, stubCtx);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/refused.*redirect/i);
    expect(res.output).toMatch(/not on the allowlist/);
  });

  it("follows valid redirects to allowlisted hosts", async () => {
    let callCount = 0;
    const skill = createFetchUrlSkill({
      allowlist: new Set(["example.com"]),
      fetch: (async (input: unknown) => {
        callCount++;
        if (callCount === 1) {
          return new Response("", {
            status: 302,
            headers: { location: "https://example.com/final" },
          });
        }
        return new Response("final content", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const res = await skill.execute({ url: "https://example.com/start" }, stubCtx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("final content");
  });

  it("limits redirect depth", async () => {
    const skill = createFetchUrlSkill({
      allowlist: new Set(["example.com"]),
      maxRedirects: 3,
      fetch: (async (input: unknown) => {
        // Always redirect
        return new Response("", {
          status: 302,
          headers: { location: "https://example.com/loop" },
        });
      }) as unknown as typeof fetch,
    });
    const res = await skill.execute({ url: "https://example.com/start" }, stubCtx);
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/too many redirects/);
  });

  it("handles non-redirect responses normally (200)", async () => {
    const skill = createFetchUrlSkill({
      allowlist: new Set(["example.com"]),
      fetch: (async () => {
        return new Response("direct response", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }) as unknown as typeof fetch,
    });
    const res = await skill.execute({ url: "https://example.com/page" }, stubCtx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("direct response");
  });
});
