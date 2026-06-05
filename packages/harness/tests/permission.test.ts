import { describe, expect, it, vi } from "vitest";
import {
  PermissionMemo,
  type PermissionDecision,
  type PermissionPersistence,
} from "../src/index.ts";

describe("PermissionMemo — basic decisions", () => {
  it("is not approved before any decision is recorded", () => {
    const memo = new PermissionMemo();
    expect(memo.isApproved("write_file")).toBe(false);
  });

  it("'once' does not remember the approval", async () => {
    const memo = new PermissionMemo();
    await memo.remember("write_file", { scope: "once" });
    expect(memo.isApproved("write_file")).toBe(false);
  });

  it("'session' remembers for the rest of the session", async () => {
    const memo = new PermissionMemo();
    await memo.remember("write_file", { scope: "session" });
    expect(memo.isApproved("write_file")).toBe(true);
  });

  it("'project' remembers and (when persistence is wired) writes it through", async () => {
    const added: string[] = [];
    const persistence: PermissionPersistence = {
      async load() { return []; },
      async add(k) { added.push(k); },
    };
    const memo = new PermissionMemo({ persistence });
    await memo.remember("write_file", { scope: "project" });
    expect(memo.isApproved("write_file")).toBe(true);
    expect(added).toEqual(["skill:write_file"]);
  });

  it("'deny' does NOT mark the skill approved", async () => {
    const memo = new PermissionMemo();
    await memo.remember("write_file", { scope: "deny" });
    expect(memo.isApproved("write_file")).toBe(false);
  });

  it("clear() forgets every session/project decision", async () => {
    const memo = new PermissionMemo();
    await memo.remember("write_file", { scope: "session" });
    expect(memo.isApproved("write_file")).toBe(true);
    memo.clear();
    expect(memo.isApproved("write_file")).toBe(false);
  });
});

describe("PermissionMemo — perArgs scoping", () => {
  it("treats two calls with different args as separate approvals", async () => {
    const memo = new PermissionMemo();
    await memo.remember("write_file", { scope: "session", perArgs: true }, { path: "a.txt" });
    expect(memo.isApproved("write_file", { path: "a.txt" })).toBe(true);
    expect(memo.isApproved("write_file", { path: "b.txt" })).toBe(false);
  });

  it("a skill-scope approval covers ANY args (the blanket case)", async () => {
    const memo = new PermissionMemo();
    await memo.remember("write_file", { scope: "session" }); // no perArgs
    expect(memo.isApproved("write_file", { path: "a.txt" })).toBe(true);
    expect(memo.isApproved("write_file", { path: "anything-else" })).toBe(true);
  });

  it("honors a custom hashArgs (used for non-JSON-safe args)", async () => {
    const memo = new PermissionMemo({ hashArgs: () => "ALWAYS-SAME" });
    await memo.remember("write_file", { scope: "session", perArgs: true }, { x: 1 });
    expect(memo.isApproved("write_file", { x: 2 })).toBe(true);
  });
});

describe("PermissionMemo — hydration from persistence", () => {
  it("populates project approvals from persistence on hydrate()", async () => {
    const persistence: PermissionPersistence = {
      async load() { return ["skill:write_file"]; },
      async add() {},
    };
    const memo = new PermissionMemo({ persistence });
    expect(memo.isApproved("write_file")).toBe(false);
    await memo.hydrate();
    expect(memo.isApproved("write_file")).toBe(true);
  });

  it("hydrate() is idempotent (second call is a no-op)", async () => {
    const load = vi.fn(async () => ["skill:write_file"]);
    const persistence: PermissionPersistence = { load, async add() {} };
    const memo = new PermissionMemo({ persistence });
    await memo.hydrate();
    await memo.hydrate();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("PermissionMemo.wrap — confirmTool integration", () => {
  it("skips the prompt when an earlier 'session' approval is on file", async () => {
    const memo = new PermissionMemo();
    await memo.remember("write_file", { scope: "session" });
    const ask = vi.fn<() => Promise<PermissionDecision>>(async () => ({ scope: "deny" }));
    const confirm = memo.wrap(ask);
    const approved = await confirm(
      { name: "write_file", args: { path: "x" } },
      { name: "write_file", description: "" },
    );
    expect(approved).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks once and remembers when scope is 'session'", async () => {
    const memo = new PermissionMemo();
    const ask = vi.fn<() => Promise<PermissionDecision>>(async () => ({ scope: "session" }));
    const confirm = memo.wrap(ask);

    expect(await confirm({ name: "write_file", args: {} }, { name: "write_file", description: "" })).toBe(true);
    expect(await confirm({ name: "write_file", args: {} }, { name: "write_file", description: "" })).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("denies when ask returns 'deny' and asks again next time", async () => {
    const memo = new PermissionMemo();
    const ask = vi.fn<() => Promise<PermissionDecision>>(async () => ({ scope: "deny" }));
    const confirm = memo.wrap(ask);
    expect(await confirm({ name: "x", args: {} }, { name: "x", description: "" })).toBe(false);
    expect(await confirm({ name: "x", args: {} }, { name: "x", description: "" })).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("'once' grants the call but does NOT memoize", async () => {
    const memo = new PermissionMemo();
    const ask = vi.fn<() => Promise<PermissionDecision>>(async () => ({ scope: "once" }));
    const confirm = memo.wrap(ask);
    expect(await confirm({ name: "x", args: {} }, { name: "x", description: "" })).toBe(true);
    expect(await confirm({ name: "x", args: {} }, { name: "x", description: "" })).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("'project' approval persists via the configured persistence and survives hydrate", async () => {
    const stored: string[] = [];
    const persistence: PermissionPersistence = {
      async load() { return [...stored]; },
      async add(k) { stored.push(k); },
    };
    const memo = new PermissionMemo({ persistence });
    const confirm = memo.wrap(async () => ({ scope: "project" }));
    await confirm({ name: "write_file", args: {} }, { name: "write_file", description: "" });
    expect(stored).toEqual(["skill:write_file"]);

    // A fresh memo with the same persistence rehydrates the approval.
    const memo2 = new PermissionMemo({ persistence });
    await memo2.hydrate();
    expect(memo2.isApproved("write_file")).toBe(true);
  });
});
