import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@miniclaw/memory-inmemory";
import type { AuditSink, MemoryStore, SkillContext } from "@miniclaw/core";
import { createCronSkills } from "../skills/cron/handler.ts";

function makeCtx(channel?: string): SkillContext {
  return { memory: {} as MemoryStore, audit: {} as AuditSink, dbPath: ":memory:", channel };
}

describe("cron skills", () => {
  it("cron_add stores a job and reports the next fire", async () => {
    const store = new InMemoryStore();
    const skills = createCronSkills(store);
    const add = skills.find((s) => s.name === "cron_add")!;
    const res = await add.execute(
      { name: "morning brief", prompt: "what's on my calendar?", schedule: "@every 1h" },
      makeCtx(),
    );
    expect(res.ok).toBe(true);
    expect(store.listCron()).toHaveLength(1);
  });

  it("cron_add stores the current channel for proactive delivery", async () => {
    const store = new InMemoryStore();
    const skills = createCronSkills(store);
    const add = skills.find((s) => s.name === "cron_add")!;
    await add.execute(
      { name: "brief", prompt: "send brief", schedule: "@every 1h" },
      makeCtx("discord:dm:u1"),
    );
    expect(store.getCron(1)!.channel).toBe("discord:dm:u1");
  });

  it("reminder_add stores a one-shot reminder on the current channel", async () => {
    const store = new InMemoryStore();
    const skills = createCronSkills(store);
    const add = skills.find((s) => s.name === "reminder_add")!;
    const before = Date.now();
    const res = await add.execute(
      { name: "trash", message: "take out the trash", delaySeconds: 30 },
      makeCtx("discord:dm:u1"),
    );
    expect(res.ok).toBe(true);
    const job = store.getCron(1)!;
    expect(job.channel).toBe("discord:dm:u1");
    expect(job.schedule).toBe("@once");
    expect(job.prompt).toContain("take out the trash");
    expect(job.nextRunAt).toBeGreaterThanOrEqual(before + 30_000);
  });

  it("cron_add rejects an unsupported schedule", async () => {
    const store = new InMemoryStore();
    const skills = createCronSkills(store);
    const add = skills.find((s) => s.name === "cron_add")!;
    const res = await add.execute(
      { name: "bad", prompt: "x", schedule: "every banana" },
      makeCtx(),
    );
    expect(res.ok).toBe(false);
    expect(store.listCron()).toHaveLength(0);
  });

  it("cron_list returns one line per job", async () => {
    const store = new InMemoryStore();
    store.addCron("a", "p1", "@every 1m", Date.now() + 60_000);
    store.addCron("b", "p2", "@every 1h", Date.now() + 3_600_000);
    const skills = createCronSkills(store);
    const list = skills.find((s) => s.name === "cron_list")!;
    const res = await list.execute({}, makeCtx());
    expect(res.ok).toBe(true);
    expect(res.output).toContain("#1");
    expect(res.output).toContain("#2");
  });

  it("cron_remove removes by id", async () => {
    const store = new InMemoryStore();
    store.addCron("a", "p", "@every 1m", Date.now() + 60_000);
    const skills = createCronSkills(store);
    const remove = skills.find((s) => s.name === "cron_remove")!;
    await remove.execute({ id: 1 }, makeCtx());
    expect(store.listCron()).toHaveLength(0);
  });

  it("cron_pause toggles status", async () => {
    const store = new InMemoryStore();
    store.addCron("a", "p", "@every 1m", Date.now() + 60_000);
    const skills = createCronSkills(store);
    const pause = skills.find((s) => s.name === "cron_pause")!;
    await pause.execute({ id: 1, paused: true }, makeCtx());
    expect(store.getCron(1)!.status).toBe("paused");
    await pause.execute({ id: 1, paused: false }, makeCtx());
    expect(store.getCron(1)!.status).toBe("active");
  });
});
