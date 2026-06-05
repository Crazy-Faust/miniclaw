import { describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "@miniclaw/core";
import {
  clearCommand,
  compactCommand,
  type IOAdapter,
  type MetaCommandContext,
  modelCommand,
  resumeCommand,
  type SessionControls,
} from "../src/index.ts";

class CapturingIO implements IOAdapter {
  outputs: string[] = [];
  async readLine() { return null; }
  write(text: string) { this.outputs.push(text); }
  close() {}
  get text() { return this.outputs.join(""); }
}

function makeCtx(): { ctx: MetaCommandContext; io: CapturingIO; stopped: boolean } {
  const io = new CapturingIO();
  let stopped = false;
  const ctx: MetaCommandContext = { io, stop: () => { stopped = true; } };
  return { ctx, io, get stopped() { return stopped; } } as never;
}

describe("/clear", () => {
  it("matches '/clear' and calls SessionControls.clear()", async () => {
    const clear = vi.fn(async () => {});
    const cmd = clearCommand({ clear });
    const { ctx, io } = makeCtx();
    expect(cmd.matches("/clear")).toBe(true);
    expect(cmd.matches("/clear something")).toBe(false);
    await cmd.run("/clear", ctx);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(io.text).toMatch(/cleared/);
  });

  it("reports gracefully when SessionControls.clear is missing", async () => {
    const cmd = clearCommand({});
    const { ctx, io } = makeCtx();
    await cmd.run("/clear", ctx);
    expect(io.text).toMatch(/doesn't support/);
  });
});

describe("/compact", () => {
  it("invokes SessionControls.compact() and reports success", async () => {
    const compact = vi.fn(async () => {});
    const cmd = compactCommand({ compact });
    const { ctx, io } = makeCtx();
    await cmd.run("/compact", ctx);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(io.text).toMatch(/compacted/);
  });

  it("surfaces an error from compact() without crashing the session", async () => {
    const compact = vi.fn(async () => { throw new Error("budget too small"); });
    const cmd = compactCommand({ compact });
    const { ctx, io } = makeCtx();
    await cmd.run("/compact", ctx);
    expect(io.text).toMatch(/budget too small/);
  });
});

describe("/model", () => {
  it("with no arg, shows current model + available list", async () => {
    const controls: SessionControls = {
      getModel: () => "claude-sonnet-4-6",
      listAvailableModels: () => ["claude-sonnet-4-6", "claude-haiku-4-5"],
    };
    const cmd = modelCommand(controls);
    const { ctx, io } = makeCtx();
    await cmd.run("/model", ctx);
    expect(io.text).toMatch(/current: claude-sonnet-4-6/);
    expect(io.text).toMatch(/available:.*claude-haiku-4-5/);
  });

  it("with an arg, calls setModel and reports the new value", async () => {
    const setModel = vi.fn(async () => {});
    const cmd = modelCommand({ setModel, getModel: () => "old" });
    const { ctx, io } = makeCtx();
    await cmd.run("/model claude-haiku-4-5", ctx);
    expect(setModel).toHaveBeenCalledWith("claude-haiku-4-5");
    expect(io.text).toMatch(/model -> claude-haiku-4-5/);
  });

  it("surfaces a setModel error", async () => {
    const setModel = vi.fn(async () => { throw new Error("unknown model"); });
    const cmd = modelCommand({ setModel });
    const { ctx, io } = makeCtx();
    await cmd.run("/model bogus", ctx);
    expect(io.text).toMatch(/could not switch model: unknown model/);
  });

  it("reports unsupported when neither getModel nor setModel is wired", async () => {
    const cmd = modelCommand({});
    const { ctx, io } = makeCtx();
    await cmd.run("/model bogus", ctx);
    expect(io.text).toMatch(/doesn't support/);
  });
});

describe("/resume", () => {
  it("with no arg, lists prior conversations newest-first", async () => {
    const list: ConversationSummary[] = [
      { id: 3, startedAt: 0, lastActivityAt: 1_700_000_000_000, messageCount: 4 },
      { id: 1, startedAt: 0, lastActivityAt: 1_699_000_000_000, messageCount: 2 },
    ];
    const cmd = resumeCommand({ listConversations: () => list });
    const { ctx, io } = makeCtx();
    await cmd.run("/resume", ctx);
    expect(io.text).toMatch(/#3/);
    expect(io.text).toMatch(/#1/);
    expect(io.text).toMatch(/4 messages/);
    expect(io.text).toMatch(/\/resume <id>/);
  });

  it("with no arg and no history, reports the empty case", async () => {
    const cmd = resumeCommand({ listConversations: () => [] });
    const { ctx, io } = makeCtx();
    await cmd.run("/resume", ctx);
    expect(io.text).toMatch(/no prior conversations/);
  });

  it("with an id, calls SessionControls.resume(id)", async () => {
    const resume = vi.fn(async () => {});
    const cmd = resumeCommand({ resume });
    const { ctx, io } = makeCtx();
    await cmd.run("/resume 42", ctx);
    expect(resume).toHaveBeenCalledWith(42);
    expect(io.text).toMatch(/resumed conversation #42/);
  });

  it("surfaces a resume() error", async () => {
    const cmd = resumeCommand({ resume: async () => { throw new Error("not found"); } });
    const { ctx, io } = makeCtx();
    await cmd.run("/resume 99", ctx);
    expect(io.text).toMatch(/resume failed: not found/);
  });
});
