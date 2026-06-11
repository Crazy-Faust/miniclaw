import { z } from "zod";
import { normalizeMemoryFolderPath, ok, type Skill } from "@miniclaw/core";

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
    "Persist a durable fact, preference, or note to long-term memory. Use this whenever the user " +
    "tells you something they will likely want recalled in future sessions (preferences, decisions, " +
    "context about themselves or their work).",
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
      `stored memory #${id} (kind=${args.kind}, folder=${folder}, tags=[${args.tags.join(", ")}])`,
    );
  },
};

const SearchParams = z.object({
  query: z.string().min(1).describe("Natural-language query; matched via the MemoryStore."),
  limit: z.number().int().min(1).max(20).default(5),
  folder: z
    .string()
    .optional()
    .describe("Optional relative folder path to restrict memory search."),
});

export const searchMemorySkill: Skill<z.infer<typeof SearchParams>> = {
  name: "search_memory",
  description:
    "Search over long-term memory. Returns the most relevant prior memories. " +
    "Use this before answering any question that might depend on what you've been told before.",
  parameters: SearchParams,
  execute(args, ctx) {
    let folder: string | undefined;
    try {
      folder = args.folder ? normalizeMemoryFolderPath(args.folder) : undefined;
    } catch (err) {
      return { ok: false, output: `invalid folder: ${(err as Error).message}` };
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
