import { describe, expect, it } from "vitest";
import type {
  AssistantTurn,
  LLMProvider,
  MemoryMaintenanceJob,
  MemoryMaintenanceQueue,
  Message,
  ToolSpec,
  WikiFolderRecord,
  WikiMaintenanceAction,
  WikiPageInput,
  WikiPageRecord,
  WikiSearchResult,
  WikiStore,
} from "@miniclaw/core";
import {
  createWikiSkills,
  MemoryWikiMaintainer,
} from "../src/index.ts";

class ScriptedLLM implements LLMProvider {
  calls: Array<{ system: string; messages: Message[]; tools: ToolSpec[] }> = [];
  constructor(private readonly turns: AssistantTurn[]) {}
  async chat(opts: { system: string; messages: Message[]; tools: ToolSpec[] }): Promise<AssistantTurn> {
    this.calls.push(opts);
    const turn = this.turns.shift();
    if (!turn) throw new Error("ScriptedLLM ran out of turns");
    return turn;
  }
}

class FakeQueue implements MemoryMaintenanceQueue {
  jobs: MemoryMaintenanceJob[] = [{
    id: 1,
    type: "memory_write",
    memoryId: 7,
    payload: { memoryId: 7, content: "user prefers helix", folder: "inbox" },
    status: "pending",
    attempts: 0,
    availableAt: 0,
    claimedAt: null,
    workerId: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  }];

  enqueueMemoryMaintenanceJob(): number { return 99; }

  claimMemoryMaintenanceJobs(limit: number, workerId: string): MemoryMaintenanceJob[] {
    const rows = this.jobs.filter((j) => j.status === "pending").slice(0, limit);
    for (const job of rows) {
      job.status = "running";
      job.workerId = workerId;
      job.attempts += 1;
    }
    return rows;
  }

  completeMemoryMaintenanceJob(id: number): void {
    this.jobs.find((j) => j.id === id)!.status = "completed";
  }

  failMemoryMaintenanceJob(id: number, error: string): void {
    const job = this.jobs.find((j) => j.id === id)!;
    job.status = "pending";
    job.lastError = error;
  }

  pendingMemoryMaintenanceJobs(): MemoryMaintenanceJob[] {
    return this.jobs.filter((j) => j.status === "pending");
  }
}

class FakeWiki implements WikiStore {
  actions: WikiMaintenanceAction[] = [];
  pages = new Map<string, WikiPageRecord>();

  applyWikiMaintenanceActions(actions: WikiMaintenanceAction[]): void {
    this.actions.push(...actions);
  }

  upsertWikiPage(page: WikiPageInput): void {
    this.pages.set(page.path, {
      path: page.path,
      folder: page.folder ?? "inbox",
      title: page.title,
      content: page.content,
      tags: page.tags ?? [],
      sourceMemoryIds: page.sourceMemoryIds ?? [],
      createdAt: 0,
      updatedAt: 0,
    });
  }

  readWikiPage(path: string): WikiPageRecord | null {
    return this.pages.get(path) ?? null;
  }

  listWikiPages(): WikiPageRecord[] { return [...this.pages.values()]; }
  listWikiFolders(): WikiFolderRecord[] { return [{ path: "inbox", title: "Inbox", createdAt: 0, updatedAt: 0 }]; }
  searchWiki(): WikiSearchResult[] {
    return [...this.pages.values()].map((p) => ({
      path: p.path,
      folder: p.folder,
      title: p.title,
      content: p.content,
      tags: p.tags,
      sourceMemoryIds: p.sourceMemoryIds,
    }));
  }
  addWikiLink(): void {}
  appendWikiLog(): number { return 1; }
  updateMemoryMetadata(): void {}
}

describe("MemoryWikiMaintainer", () => {
  it("claims queued jobs, validates JSON actions, applies them, and completes the jobs", async () => {
    const queue = new FakeQueue();
    const wiki = new FakeWiki();
    const llm = new ScriptedLLM([{
      kind: "final",
      text: JSON.stringify({
        summary: "updated helix page",
        actions: [
          {
            type: "upsert_page",
            path: "personal/preferences",
            title: "Preferences",
            content: "# Preferences\n- User prefers helix.",
            tags: ["preferences"],
            sourceMemoryIds: [7],
          },
          {
            type: "mark_memory",
            memoryId: 7,
            status: "superseded",
            canonicalPagePath: "personal/preferences",
          },
        ],
      }),
    }]);

    const result = await new MemoryWikiMaintainer({ llm, queue, wiki }).runOnce();

    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0, actions: 2 });
    expect(queue.jobs[0]!.status).toBe("completed");
    expect(wiki.actions).toEqual([
      expect.objectContaining({ type: "upsert_page", path: "personal/preferences.md" }),
      expect.objectContaining({ type: "mark_memory", canonicalPagePath: "personal/preferences.md" }),
    ]);
  });

  it("records invalid model JSON as a retryable failed attempt", async () => {
    const queue = new FakeQueue();
    const wiki = new FakeWiki();
    const llm = new ScriptedLLM([{ kind: "final", text: "not json" }]);

    const result = await new MemoryWikiMaintainer({ llm, queue, wiki }).runOnce();

    expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
    expect(queue.jobs[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(queue.jobs[0]!.lastError).toMatch(/JSON|object/);
    expect(wiki.actions).toHaveLength(0);
  });
});

describe("wiki skills", () => {
  it("search/read/list expose wiki pages and folders", async () => {
    const wiki = new FakeWiki();
    wiki.upsertWikiPage({
      path: "inbox/alpha.md",
      folder: "inbox",
      title: "Alpha",
      content: "Alpha page body",
      tags: ["alpha"],
      sourceMemoryIds: [1],
    });
    const skills = createWikiSkills({ wiki });
    const search = skills[0]!;
    const read = skills[1]!;
    const list = skills[2]!;

    await expect(Promise.resolve(search.execute({ query: "alpha", limit: 5 }, fakeCtx()))).resolves.toMatchObject({
      ok: true,
      output: expect.stringContaining("Alpha page body"),
    });
    await expect(Promise.resolve(read.execute({ path: "inbox/alpha.md" }, fakeCtx()))).resolves.toMatchObject({
      ok: true,
      output: expect.stringContaining("# Alpha"),
    });
    await expect(Promise.resolve(list.execute({ limit: 50 }, fakeCtx()))).resolves.toMatchObject({
      ok: true,
      output: expect.stringContaining("inbox"),
    });
  });
});

function fakeCtx() {
  return {
    memory: { add: () => 0, search: () => [], listRecent: () => [] },
    audit: { logToolCall: () => {} },
    dbPath: ":memory:",
  };
}
