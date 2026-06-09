import Database from "better-sqlite3";
import { z } from "zod";
import { fail, ok, type Skill } from "@miniclaw/core";
import { checkSqlQuery } from "./security.ts";

const Params = z.object({
  sql: z.string().describe("A single read-only SELECT (or WITH ... SELECT) statement."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe("Hard cap on rows returned (default 50, max 200)."),
});

export const sqlQuerySkill: Skill<z.infer<typeof Params>> = {
  name: "sql_query",
  description:
    "Run a read-only SQL query against miniclaw's local SQLite DB. " +
    "Tables: memories(id, kind, content, tags, created_at), " +
    "conversations(id, started_at), " +
    "messages(id, conv_id, role, content, tool_calls_json, created_at), " +
    "audit_log(id, ts, skill, args_json, result_summary, ok). " +
    "Timestamps are unix-millis. Only SELECT / WITH allowed.",
  parameters: Params,
  execute(args, ctx) {
    const check = checkSqlQuery(args.sql);
    if (!check.ok) return fail(`refused: ${check.reason}`);

    let db: Database.Database | undefined;
    try {
      db = new Database(ctx.dbPath, { readonly: true });
      db.pragma("query_only = ON");
      const rows = db.prepare(check.sql).all() as unknown[];
      const capped = rows.slice(0, args.limit);
      const note = rows.length > capped.length ? ` (truncated from ${rows.length})` : "";
      return ok(
        `rows=${capped.length}${note}\n<tool_output>\n${JSON.stringify(capped, null, 2)}\n</tool_output>`,
      );
    } catch (err) {
      return fail(`sql error: ${(err as Error).message}`);
    } finally {
      db?.close();
    }
  },
};
