import { z } from "zod";
import {
  fail,
  normalizeMemoryFolderPath,
  normalizeWikiPagePath,
  ok,
  type LLMProvider,
  type MemoryMaintenanceJob,
  type MemoryMaintenanceQueue,
  type Skill,
  type WikiMaintenanceAction,
  type WikiStore,
} from "@miniclaw/core";

export const MEMORY_WIKI_SYSTEM_PROMPT = `You maintain miniclaw's SQLite-native LLM Wiki.

Raw memories are immutable source material. The wiki is the long-term memory surface the agent reads from. Your job is to integrate new memories into durable wiki pages, keep pages organized into folders, add useful links, and mark raw memories as duplicate/superseded/retired when the wiki page preserves the useful information.

Rules:
1. Output one JSON object only. No markdown fences, no prose outside JSON.
2. Never delete raw memories.
3. Prefer small, stable markdown pages with clear headings and links using [[page/path.md]] syntax.
4. Use folders such as inbox, personal/preferences, projects, research, or tasks when they fit.
5. Avoid storing secrets or credentials. If a memory appears secret-like, keep it as an active raw memory and log that it was skipped.
6. Preserve sourceMemoryIds on every upsert_page action that used a memory.
7. Prefer marking a processed source memory superseded when the wiki captures it. Leave it active only when it is not integrated yet, was skipped, or needs future human/model attention.

JSON shape:
{
  "summary": "short summary",
  "actions": [
    { "type": "upsert_page", "path": "folder/page.md", "folder": "folder", "title": "Title", "content": "# Title\\n...", "tags": ["tag"], "sourceMemoryIds": [1] },
    { "type": "add_link", "fromPath": "folder/a.md", "toPath": "folder/b.md", "kind": "related" },
    { "type": "mark_memory", "memoryId": 1, "status": "active|duplicate|superseded|retired", "canonicalPagePath": "folder/page.md" },
    { "type": "append_log", "eventType": "memory_write", "message": "what changed", "metadata": { "memoryIds": [1] } }
  ]
}`;

const ActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("upsert_page"),
    path: z.string().min(1),
    folder: z.string().optional(),
    title: z.string().min(1),
    content: z.string().min(1),
    tags: z.array(z.string()).default([]),
    sourceMemoryIds: z.array(z.number().int().positive()).default([]),
  }),
  z.object({
    type: z.literal("add_link"),
    fromPath: z.string().min(1),
    toPath: z.string().min(1),
    kind: z.string().default("related"),
  }),
  z.object({
    type: z.literal("mark_memory"),
    memoryId: z.number().int().positive(),
    status: z.enum(["active", "duplicate", "superseded", "retired"]),
    canonicalPagePath: z.string().nullable().optional(),
    folder: z.string().optional(),
  }),
  z.object({
    type: z.literal("append_log"),
    eventType: z.string().default("maintenance"),
    message: z.string().min(1),
    metadata: z.record(z.unknown()).default({}),
  }),
]);

const ResponseSchema = z.object({
  summary: z.string().default("maintenance completed"),
  actions: z.array(ActionSchema).default([]),
});

const MaintainParams = z.object({
  batchSize: z.number().int().min(1).max(50).default(10),
  maxBatches: z.number().int().min(1).max(20).default(5),
});

const SearchParams = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).default(5),
});

const ReadParams = z.object({
  path: z.string().min(1),
});

const ListParams = z.object({
  folder: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export interface MemoryWikiMaintainerOpts {
  llm: LLMProvider;
  queue: MemoryMaintenanceQueue;
  wiki: WikiStore;
  workerId?: string;
}

export interface MemoryWikiRunResult {
  claimed: number;
  completed: number;
  failed: number;
  actions: number;
  summaries: string[];
}

export class MemoryWikiMaintainer {
  private readonly workerId: string;

  constructor(private readonly opts: MemoryWikiMaintainerOpts) {
    this.workerId = opts.workerId ?? `memory-wiki-${Math.random().toString(36).slice(2)}`;
  }

  async runOnce(batchSize = 10): Promise<MemoryWikiRunResult> {
    const jobs = this.opts.queue.claimMemoryMaintenanceJobs(batchSize, this.workerId);
    if (jobs.length === 0) return emptyResult();

    const result: MemoryWikiRunResult = {
      claimed: jobs.length,
      completed: 0,
      failed: 0,
      actions: 0,
      summaries: [],
    };

    try {
      const actionsResult = await this.planActions(jobs);
      this.opts.wiki.applyWikiMaintenanceActions(actionsResult.actions);
      const summary = actionsResult.summary || "maintenance completed";
      for (const job of jobs) {
        this.opts.queue.completeMemoryMaintenanceJob(job.id, summary);
      }
      result.completed = jobs.length;
      result.actions = actionsResult.actions.length;
      result.summaries.push(summary);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      for (const job of jobs) {
        this.opts.queue.failMemoryMaintenanceJob(job.id, message);
      }
      result.failed = jobs.length;
      result.summaries.push(`failed: ${message}`);
    }

    return result;
  }

  async drain(opts: { batchSize?: number; maxBatches?: number } = {}): Promise<MemoryWikiRunResult> {
    const batchSize = opts.batchSize ?? 10;
    const maxBatches = opts.maxBatches ?? 5;
    const total = emptyResult();
    for (let i = 0; i < maxBatches; i++) {
      const next = await this.runOnce(batchSize);
      mergeResult(total, next);
      if (next.claimed === 0) break;
    }
    return total;
  }

  private async planActions(jobs: MemoryMaintenanceJob[]): Promise<{
    summary: string;
    actions: WikiMaintenanceAction[];
  }> {
    const turn = await this.opts.llm.chat({
      system: MEMORY_WIKI_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildMaintenancePrompt(jobs) }],
      tools: [],
    });
    const parsed = ResponseSchema.parse(JSON.parse(extractJsonObject(turn.text)));
    return {
      summary: parsed.summary,
      actions: parsed.actions.map(normalizeAction),
    };
  }
}

export interface MemoryWikiWorkerOpts {
  maintainer: MemoryWikiMaintainer;
  tickMs?: number;
  batchSize?: number;
}

export class MemoryWikiWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly opts: MemoryWikiWorkerOpts) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 5_000);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.opts.maintainer.runOnce(this.opts.batchSize ?? 10);
    } finally {
      this.running = false;
    }
  }
}

export function createWikiSkills(opts: {
  wiki: WikiStore;
  maintainer?: MemoryWikiMaintainer;
}): Skill<unknown>[] {
  const wikiSearch: Skill<z.infer<typeof SearchParams>> = {
    name: "wiki_search",
    description: "Search synthesized LLM Wiki pages stored in SQLite.",
    parameters: SearchParams,
    execute(args) {
      const hits = opts.wiki.searchWiki(args.query, args.limit);
      if (hits.length === 0) return ok("no matching wiki pages");
      return ok(
        hits
          .map((h) => `${h.path} [${h.folder}] ${h.title}\n${truncate(h.content, 800)}`)
          .join("\n\n"),
      );
    },
  };

  const wikiRead: Skill<z.infer<typeof ReadParams>> = {
    name: "wiki_read",
    description: "Read one synthesized wiki page by path.",
    parameters: ReadParams,
    execute(args) {
      const page = opts.wiki.readWikiPage(args.path);
      if (!page) return fail(`unknown wiki page: ${args.path}`);
      return ok(
        `# ${page.title}\npath=${page.path} folder=${page.folder} tags=[${page.tags.join(", ")}]\n\n` +
          page.content,
      );
    },
  };

  const wikiList: Skill<z.infer<typeof ListParams>> = {
    name: "wiki_list",
    description: "List wiki folders, or pages within one folder.",
    parameters: ListParams,
    execute(args) {
      if (!args.folder) {
        const folders = opts.wiki.listWikiFolders();
        if (folders.length === 0) return ok("(no wiki folders)");
        return ok(folders.map((f) => `${f.path} — ${f.title}`).join("\n"));
      }
      const pages = opts.wiki.listWikiPages(args.folder, args.limit);
      if (pages.length === 0) return ok(`(no wiki pages in ${args.folder})`);
      return ok(pages.map((p) => `${p.path} — ${p.title}`).join("\n"));
    },
  };

  const wikiMaintain: Skill<z.infer<typeof MaintainParams>> = {
    name: "wiki_maintain",
    description: "Drain queued memory-to-wiki maintenance jobs using the configured LLM maintainer.",
    parameters: MaintainParams,
    async execute(args) {
      if (!opts.maintainer) return fail("wiki maintainer is not configured");
      const result = await opts.maintainer.drain(args);
      return ok(formatMaintenanceResult(result));
    },
  };

  return [wikiSearch, wikiRead, wikiList, wikiMaintain] as Skill<unknown>[];
}

export function formatMaintenanceResult(result: MemoryWikiRunResult): string {
  return (
    `claimed=${result.claimed} completed=${result.completed} failed=${result.failed} actions=${result.actions}` +
    (result.summaries.length ? `\n${result.summaries.join("\n")}` : "")
  );
}

function buildMaintenancePrompt(jobs: MemoryMaintenanceJob[]): string {
  return (
    "Process these memory maintenance jobs. Return the strict JSON response described in the system prompt.\n\n" +
    JSON.stringify(
      jobs.map((job) => ({
        id: job.id,
        type: job.type,
        memoryId: job.memoryId,
        payload: job.payload,
      })),
      null,
      2,
    )
  );
}

function normalizeAction(action: z.infer<typeof ActionSchema>): WikiMaintenanceAction {
  switch (action.type) {
    case "upsert_page":
      return {
        ...action,
        path: normalizeWikiPagePath(action.path, action.folder),
        folder: action.folder ? normalizeMemoryFolderPath(action.folder) : undefined,
      };
    case "add_link":
      return {
        ...action,
        fromPath: normalizeWikiPagePath(action.fromPath),
        toPath: normalizeWikiPagePath(action.toPath),
      };
    case "mark_memory":
      return {
        ...action,
        folder: action.folder ? normalizeMemoryFolderPath(action.folder) : undefined,
        canonicalPagePath: action.canonicalPagePath
          ? normalizeWikiPagePath(action.canonicalPagePath)
          : action.canonicalPagePath,
      };
    case "append_log":
      return action;
  }
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) return extractJsonObject(fenced[1]);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error("model did not return a JSON object");
}

function emptyResult(): MemoryWikiRunResult {
  return { claimed: 0, completed: 0, failed: 0, actions: 0, summaries: [] };
}

function mergeResult(target: MemoryWikiRunResult, next: MemoryWikiRunResult): void {
  target.claimed += next.claimed;
  target.completed += next.completed;
  target.failed += next.failed;
  target.actions += next.actions;
  target.summaries.push(...next.summaries);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + `... (+${text.length - max} chars)`;
}
