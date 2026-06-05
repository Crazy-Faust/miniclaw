import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStore } from "@miniclaw/memory-inmemory";
import { WindowedContextManager, loadPromptInjectionFiles } from "../src/manager.ts";

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "miniclaw-pi-"));
}

describe("loadPromptInjectionFiles", () => {
  it("returns empty when no files exist", () => {
    const dir = makeWorkspace();
    try {
      expect(loadPromptInjectionFiles(dir)).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("concatenates AGENTS.md and TOOLS.md when present", () => {
    const dir = makeWorkspace();
    try {
      writeFileSync(join(dir, "AGENTS.md"), "## Style\nbe terse.");
      writeFileSync(join(dir, "TOOLS.md"), "prefer search_memory over guessing.");
      const out = loadPromptInjectionFiles(dir);
      expect(out).toContain("Project file: AGENTS.md");
      expect(out).toContain("be terse");
      expect(out).toContain("Project file: TOOLS.md");
      expect(out).toContain("prefer search_memory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps each file at maxBytes", () => {
    const dir = makeWorkspace();
    try {
      writeFileSync(join(dir, "AGENTS.md"), "x".repeat(100_000));
      const out = loadPromptInjectionFiles(dir, ["AGENTS.md"], 1024);
      expect(out.length).toBeLessThan(1500);
      expect(out).toMatch(/truncated/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("WindowedContextManager prompt injection", () => {
  it("appends AGENTS.md to the system prompt", () => {
    const dir = makeWorkspace();
    try {
      writeFileSync(join(dir, "AGENTS.md"), "always use shell with --no-pager");
      const store = new InMemoryStore();
      const convId = store.newConversation();
      const mgr = new WindowedContextManager({
        memory: store,
        conversations: store,
        conversationId: convId,
        workspaceRoot: dir,
      });
      const { system } = mgr.prepare("hi");
      expect(system).toContain("always use shell with --no-pager");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("works without a workspaceRoot (no injection)", () => {
    const store = new InMemoryStore();
    const convId = store.newConversation();
    const mgr = new WindowedContextManager({
      memory: store,
      conversations: store,
      conversationId: convId,
    });
    const { system } = mgr.prepare("hi");
    expect(system).not.toContain("Project file:");
  });
});
