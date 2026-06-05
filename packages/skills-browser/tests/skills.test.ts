import { describe, expect, it, beforeEach } from "vitest";
import type { AuditSink, MemoryStore, SkillContext } from "@miniclaw/core";
import { createBrowserSkills } from "../src/skills.ts";
import type { BrowserDriver, DriverFactory } from "../src/driver.ts";

function fakeDriver() {
  const calls: any[] = [];
  let currentUrl = "about:blank";
  return {
    calls,
    factory: {
      async create() {
        calls.push(["create"]);
        return {
          async open(url) {
            currentUrl = url;
            calls.push(["open", url]);
          },
          async readPage() {
            calls.push(["readPage"]);
            return { url: currentUrl, title: "fake page", text: "hello world" };
          },
          async screenshot(p) {
            calls.push(["screenshot", p]);
          },
          async click(s) {
            calls.push(["click", s]);
          },
          async fill(s, v) {
            calls.push(["fill", s, v]);
          },
          async close() {
            calls.push(["close"]);
          },
        } satisfies BrowserDriver;
      },
    } satisfies DriverFactory,
  };
}

function makeCtx(workspaceRoot = "/tmp/work"): SkillContext {
  return {
    memory: {} as MemoryStore,
    audit: {} as AuditSink,
    dbPath: ":memory:",
    workspaceRoot,
  };
}

describe("browser skills", () => {
  let fake: ReturnType<typeof fakeDriver>;
  beforeEach(() => {
    fake = fakeDriver();
  });

  it("browser_open initializes the driver lazily and navigates", async () => {
    const skills = createBrowserSkills({ factory: fake.factory });
    const open = skills.find((s) => s.name === "browser_open")!;
    const res = await open.execute({ url: "https://example.com" }, makeCtx());
    expect(res.ok).toBe(true);
    expect(fake.calls[0]).toEqual(["create"]);
    expect(fake.calls[1]).toEqual(["open", "https://example.com"]);
  });

  it("browser_read_page returns url + title + text", async () => {
    const skills = createBrowserSkills({ factory: fake.factory });
    const open = skills.find((s) => s.name === "browser_open")!;
    const read = skills.find((s) => s.name === "browser_read_page")!;
    await open.execute({ url: "https://example.com" }, makeCtx());
    const res = await read.execute({}, makeCtx());
    expect(res.ok).toBe(true);
    expect(res.output).toContain("https://example.com");
    expect(res.output).toContain("fake page");
    expect(res.output).toContain("hello world");
  });

  it("browser_screenshot refuses paths outside the workspace", async () => {
    const skills = createBrowserSkills({ factory: fake.factory });
    const shot = skills.find((s) => s.name === "browser_screenshot")!;
    const res = await shot.execute({ path: "/etc/passwd" }, makeCtx("/tmp/work"));
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/refused/);
  });

  it("browser_screenshot allows paths under the workspace", async () => {
    const skills = createBrowserSkills({ factory: fake.factory });
    const shot = skills.find((s) => s.name === "browser_screenshot")!;
    const res = await shot.execute({ path: "/tmp/work/out.png" }, makeCtx("/tmp/work"));
    expect(res.ok).toBe(true);
    expect(fake.calls.find((c) => c[0] === "screenshot")?.[1]).toBe("/tmp/work/out.png");
  });

  it("interactive skills declare requiresConfirmation", () => {
    const skills = createBrowserSkills({ factory: fake.factory });
    const click = skills.find((s) => s.name === "browser_click")!;
    const fill = skills.find((s) => s.name === "browser_fill")!;
    const open = skills.find((s) => s.name === "browser_open")!;
    expect(click.requiresConfirmation).toBe(true);
    expect(fill.requiresConfirmation).toBe(true);
    expect(open.requiresConfirmation).toBeUndefined();
  });

  it("surfaces a clean error when the factory fails", async () => {
    const factory: DriverFactory = {
      async create() {
        throw new Error("playwright not installed");
      },
    };
    const skills = createBrowserSkills({ factory });
    const open = skills.find((s) => s.name === "browser_open")!;
    const res = await open.execute({ url: "https://example.com" }, makeCtx());
    expect(res.ok).toBe(false);
    expect(res.output).toContain("playwright not installed");
  });
});
