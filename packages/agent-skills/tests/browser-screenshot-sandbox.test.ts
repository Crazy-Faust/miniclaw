import { describe, expect, it, beforeEach } from "vitest";
import type { AuditSink, MemoryStore, SkillContext } from "@miniclaw/core";
import { createBrowserSkills } from "../skills/browser/handler.ts";
import type { BrowserDriver, DriverFactory } from "../skills/browser/driver.ts";

function fakeDriver() {
  const calls: any[] = [];
  return {
    calls,
    factory: {
      async create() {
        calls.push(["create"]);
        return {
          async open(url) { calls.push(["open", url]); },
          async readPage() { return { url: "about:blank", title: "", text: "" }; },
          async screenshot(p) { calls.push(["screenshot", p]); },
          async click(s) { calls.push(["click", s]); },
          async fill(s, v) { calls.push(["fill", s, v]); },
          async close() { calls.push(["close"]); },
        } satisfies BrowserDriver;
      },
    } satisfies DriverFactory,
  };
}

function makeCtx(workspaceRoot?: string): SkillContext {
  return {
    memory: {} as MemoryStore,
    audit: {} as AuditSink,
    dbPath: ":memory:",
    workspaceRoot,
  };
}

// VULN-16: browser_screenshot sandbox uses resolveInsideWorkspace
describe("browser_screenshot — sandbox path resolution (VULN-16)", () => {
  let fake: ReturnType<typeof fakeDriver>;
  beforeEach(() => { fake = fakeDriver(); });

  it("rejects paths with NUL bytes", async () => {
    const skills = createBrowserSkills({ factory: fake.factory });
    const shot = skills.find((s) => s.name === "browser_screenshot")!;
    const res = await shot.execute({ path: "out\x00.png" }, makeCtx("/tmp/work"));
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/NUL/);
  });

  it("rejects paths that escape via .. traversal", async () => {
    const skills = createBrowserSkills({ factory: fake.factory });
    const shot = skills.find((s) => s.name === "browser_screenshot")!;
    const res = await shot.execute({ path: "../../../etc/passwd" }, makeCtx("/tmp/work"));
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/refused|outside/);
  });

  it("rejects absolute paths outside workspace", async () => {
    const skills = createBrowserSkills({ factory: fake.factory });
    const shot = skills.find((s) => s.name === "browser_screenshot")!;
    const res = await shot.execute({ path: "/etc/passwd" }, makeCtx("/tmp/work"));
    expect(res.ok).toBe(false);
  });

  it("allows relative paths inside workspace", async () => {
    const skills = createBrowserSkills({ factory: fake.factory });
    const shot = skills.find((s) => s.name === "browser_screenshot")!;
    const res = await shot.execute({ path: "screenshots/out.png" }, makeCtx("/tmp/work"));
    expect(res.ok).toBe(true);
  });

  it("allows absolute paths inside workspace", async () => {
    const skills = createBrowserSkills({ factory: fake.factory });
    const shot = skills.find((s) => s.name === "browser_screenshot")!;
    const res = await shot.execute({ path: "/tmp/work/out.png" }, makeCtx("/tmp/work"));
    expect(res.ok).toBe(true);
  });
});
