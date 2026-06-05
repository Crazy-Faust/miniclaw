import { z } from "zod";
import { ok, type Skill } from "@miniclaw/core";

const WriteParams = z.object({
  content: z.string().min(1).describe("The fact or preference to remember, in plain English."),
  kind: z
    .enum(["fact", "preference", "note", "task"])
    .default("note")
    .describe("Category label for the memory."),
  tags: z.array(z.string()).default([]).describe("Optional topical tags for retrieval."),
});

export const writeMemorySkill: Skill<z.infer<typeof WriteParams>> = {
  name: "write_memory",
  description:
    "Persist a durable fact, preference, or note to long-term memory. Use this whenever the user " +
    "tells you something they will likely want recalled in future sessions (preferences, decisions, " +
    "context about themselves or their work).",
  parameters: WriteParams,
  execute(args, ctx) {
    const id = ctx.memory.add(args.kind, args.content, args.tags);
    return ok(`stored memory #${id} (kind=${args.kind}, tags=[${args.tags.join(", ")}])`);
  },
};

const SearchParams = z.object({
  query: z.string().min(1).describe("Natural-language query; matched via the MemoryStore."),
  limit: z.number().int().min(1).max(20).default(5),
});

export const searchMemorySkill: Skill<z.infer<typeof SearchParams>> = {
  name: "search_memory",
  description:
    "Search over long-term memory. Returns the most relevant prior memories. " +
    "Use this before answering any question that might depend on what you've been told before.",
  parameters: SearchParams,
  execute(args, ctx) {
    const hits = ctx.memory.search(args.query, args.limit);
    if (hits.length === 0) return ok("no matching memories");
    const lines = hits.map(
      (h) => `#${h.id} [${h.kind}${h.tags.length ? " " + h.tags.join(",") : ""}] ${h.content}`,
    );
    return ok(lines.join("\n"));
  },
};
