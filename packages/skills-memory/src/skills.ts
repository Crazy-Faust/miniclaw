import { z } from "zod";
import {
  normalizeMemoryFolderPath,
  ok,
  type KnowledgeSearchResult,
  type KnowledgeStore,
  type MemoryStore,
  type Skill,
} from "@miniclaw/core";

const WriteParams = z.object({
  content: z.string().min(1).describe("The fact or preference to remember, in plain English."),
  kind: z
    .enum(["fact", "preference", "note", "task"])
    .default("note")
    .describe("Category label for the memory."),
  tags: z.array(z.string()).default([]).describe("Optional topical tags for retrieval."),
  folder: z
    .string()
    .optional()
    .describe("Optional relative wiki folder path, e.g. inbox, research/papers, personal/goals."),
});

export const writeMemorySkill: Skill<z.infer<typeof WriteParams>> = {
  name: "write_memory",
  description:
    "Ingest durable source material into the long-term memory wiki. Use this whenever the user " +
    "tells you something they will likely want recalled in future sessions; SQLite mode stores the " +
    "raw source and queues wiki maintenance.",
  parameters: WriteParams,
  execute(args, ctx) {
    let folder: string;
    try {
      folder = normalizeMemoryFolderPath(args.folder);
    } catch (err) {
      return { ok: false, output: `invalid folder: ${(err as Error).message}` };
    }
    const id = ctx.memory.add(args.kind, args.content, args.tags, { folder });
    return ok(
      `stored memory source #${id} (kind=${args.kind}, folder=${folder}, tags=[${args.tags.join(", ")}])`,
    );
  },
};

const SearchParams = z.object({
  query: z.string().min(1).describe("Natural-language query; matched against the memory wiki."),
  limit: z.number().int().min(1).max(20).default(5),
  folder: z
    .string()
    .optional()
    .describe("Optional relative folder path to restrict memory search."),
});

export const searchMemorySkill: Skill<z.infer<typeof SearchParams>> = {
  name: "search_memory",
  description:
    "Search long-term memory. Wiki-aware stores return synthesized wiki pages first and raw source " +
    "memories only as a fallback while maintenance is pending.",
  parameters: SearchParams,
  execute(args, ctx) {
    let folder: string | undefined;
    try {
      folder = args.folder ? normalizeMemoryFolderPath(args.folder) : undefined;
    } catch (err) {
      return { ok: false, output: `invalid folder: ${(err as Error).message}` };
    }
    if (isKnowledgeStore(ctx.memory)) {
      const hits = ctx.memory.searchKnowledge(args.query, args.limit, { folder });
      if (hits.length === 0) return ok("no matching memories");
      return ok(hits.map(formatKnowledgeHit).join("\n\n"));
    }

    const hits = ctx.memory.search(args.query, args.limit, { folder });
    if (hits.length === 0) return ok("no matching memories");
    const lines = hits.map(
      (h) =>
        `#${h.id} [${h.kind} folder=${h.folder ?? "inbox"} status=${h.status ?? "active"}${
          h.tags.length ? " " + h.tags.join(",") : ""
        }] ${h.content}`,
    );
    return ok(lines.join("\n"));
  },
};

function isKnowledgeStore(memory: MemoryStore): memory is MemoryStore & KnowledgeStore {
  return typeof (memory as Partial<KnowledgeStore>).searchKnowledge === "function";
}

function formatKnowledgeHit(hit: KnowledgeSearchResult): string {
  if (hit.source === "wiki") {
    return `${hit.path} [wiki folder=${hit.folder}${formatTags(hit.tags)}] ${hit.title}\n${hit.content}`;
  }
  return `#${hit.id} [raw-source folder=${hit.folder}${formatTags(hit.tags)}] ${hit.content}`;
}

function formatTags(tags: string[]): string {
  return tags.length ? ` tags=${tags.join(",")}` : "";
}
