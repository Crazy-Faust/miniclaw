// Owned by the database skill. Co-locating the SQL guard with the skill keeps
// "what the LLM can do" and "how we keep it safe" reviewable as one unit.

export type SqlCheckResult =
  | { ok: true; sql: string }
  | { ok: false; reason: string };

export function checkSqlQuery(raw: unknown): SqlCheckResult {
  if (typeof raw !== "string") return { ok: false, reason: "sql must be a string" };
  const stripped = stripSqlCommentsAndWs(raw);
  if (!stripped) return { ok: false, reason: "empty sql" };

  // A trailing single semicolon is allowed; anything beyond it is not.
  const withoutTrailing = stripped.replace(/;+\s*$/, "");
  if (withoutTrailing.includes(";")) {
    return { ok: false, reason: "multiple SQL statements are not allowed" };
  }

  const firstToken = withoutTrailing.match(/^[a-zA-Z]+/)?.[0]?.toUpperCase();
  if (firstToken !== "SELECT" && firstToken !== "WITH") {
    return { ok: false, reason: `only SELECT/WITH queries are permitted, got: ${firstToken ?? "?"}` };
  }
  if (/\bATTACH\b|\bPRAGMA\b\s+\w*\s*=/i.test(withoutTrailing)) {
    return { ok: false, reason: "ATTACH and PRAGMA assignments are not allowed" };
  }
  return { ok: true, sql: withoutTrailing };
}

function stripSqlCommentsAndWs(s: string): string {
  const noBlock = s.replace(/\/\*[\s\S]*?\*\//g, " ");
  const noLine = noBlock.replace(/--[^\n]*/g, " ");
  return noLine.trim();
}
