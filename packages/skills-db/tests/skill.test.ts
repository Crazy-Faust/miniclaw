import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillContext } from "@miniclaw/core";
import { sqlQuerySkill } from "../src/index.ts";

describe("sqlQuerySkill", () => {
  let dir: string;
  let dbPath: string;
  let ctx: SkillContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-dbq-"));
    dbPath = join(dir, "test.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT);
      INSERT INTO memories(content) VALUES ('alpha'), ('beta'), ('gamma');
    `);
    db.close();

    ctx = {
      memory: { add: () => 0, search: () => [], listRecent: () => [] },
      audit: { logToolCall: () => {} },
      dbPath,
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns rows for a SELECT", async () => {
    const res = await sqlQuerySkill.execute(
      { sql: "SELECT id, content FROM memories ORDER BY id", limit: 50 },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/rows=3/);
    expect(res.output).toContain("alpha");
    expect(res.output).toContain("gamma");
  });

  it("caps result rows at the requested limit and notes truncation", async () => {
    const res = await sqlQuerySkill.execute(
      { sql: "SELECT id FROM memories ORDER BY id", limit: 2 },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/rows=2 \(truncated from 3\)/);
  });

  it("refuses INSERT via the guard", async () => {
    const res = await sqlQuerySkill.execute(
      { sql: "INSERT INTO memories(content) VALUES ('x')", limit: 50 },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/refused/);
  });

  it("refuses multiple statements via the guard", async () => {
    const res = await sqlQuerySkill.execute(
      { sql: "SELECT 1; DROP TABLE memories", limit: 50 },
      ctx,
    );
    expect(res.ok).toBe(false);
  });

  it("reports SQL errors without crashing", async () => {
    const res = await sqlQuerySkill.execute(
      { sql: "SELECT * FROM nonexistent_table", limit: 50 },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/sql error/);
  });

  it("wraps results inside the <tool_output> delimiter", async () => {
    const res = await sqlQuerySkill.execute(
      { sql: "SELECT 1 AS n", limit: 50 },
      ctx,
    );
    expect(res.output).toMatch(/<tool_output>[\s\S]*<\/tool_output>/);
  });
});
