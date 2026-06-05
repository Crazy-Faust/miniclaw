import { describe, expect, it } from "vitest";
import { checkUrl, parseAllowlistEnv } from "../src/allowlist.ts";

describe("checkUrl", () => {
  const allow = new Set(["example.com", "*.api.example.com"]);

  it("accepts an allowlisted HTTPS URL", () => {
    const r = checkUrl("https://example.com/path?q=1", { allowlist: allow });
    expect(r.ok).toBe(true);
  });

  it("accepts a wildcard-suffix subdomain", () => {
    const r = checkUrl("https://v2.api.example.com/x", { allowlist: allow });
    expect(r.ok).toBe(true);
  });

  it("refuses the parent domain of a *.suffix entry", () => {
    const r = checkUrl("https://api.example.com/x", {
      allowlist: new Set(["*.api.example.com"]),
    });
    expect(r.ok).toBe(false);
  });

  it("refuses a non-allowlisted host", () => {
    const r = checkUrl("https://evil.example.org/", { allowlist: allow });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not on the allowlist/);
  });

  it("refuses non-http(s) schemes", () => {
    const r = checkUrl("file:///etc/passwd", { allowlist: allow });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/scheme/);
  });

  it("refuses malformed URLs", () => {
    const r = checkUrl("not a url", { allowlist: allow });
    expect(r.ok).toBe(false);
  });

  it("refuses an empty allowlist (fail-closed)", () => {
    const r = checkUrl("https://example.com/", { allowlist: new Set() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no domain allowlist/);
  });

  it("refuses a missing allowlist (fail-closed)", () => {
    const r = checkUrl("https://example.com/");
    expect(r.ok).toBe(false);
  });

  it("refuses obvious private/loopback hosts even if allowlisted", () => {
    const r = checkUrl("http://localhost/x", { allowlist: new Set(["localhost"]) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/private/);
  });

  it("refuses RFC1918 IPv4 ranges", () => {
    const r1 = checkUrl("http://10.0.0.5/", { allowlist: new Set(["10.0.0.5"]) });
    const r2 = checkUrl("http://192.168.1.1/", { allowlist: new Set(["192.168.1.1"]) });
    const r3 = checkUrl("http://172.16.0.1/", { allowlist: new Set(["172.16.0.1"]) });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r3.ok).toBe(false);
  });

  it("refuses link-local addresses (cloud metadata service)", () => {
    const r = checkUrl("http://169.254.169.254/latest/meta-data/", {
      allowlist: new Set(["169.254.169.254"]),
    });
    expect(r.ok).toBe(false);
  });

  it("refuses non-string / empty input", () => {
    expect(checkUrl("", { allowlist: allow }).ok).toBe(false);
    expect(checkUrl(undefined as unknown as string, { allowlist: allow }).ok).toBe(false);
  });
});

describe("parseAllowlistEnv", () => {
  it("returns empty set for undefined / empty input", () => {
    expect(parseAllowlistEnv(undefined).size).toBe(0);
    expect(parseAllowlistEnv("").size).toBe(0);
  });

  it("splits a comma-separated list and lowercases entries", () => {
    const s = parseAllowlistEnv(" Example.com , API.example.com , *.Foo.io ");
    expect([...s].sort()).toEqual(["*.foo.io", "api.example.com", "example.com"]);
  });
});
