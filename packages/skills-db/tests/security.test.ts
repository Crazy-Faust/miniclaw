import { describe, expect, it } from "vitest";
import { checkSqlQuery } from "../src/security.ts";

describe("checkSqlQuery", () => {
  it("accepts a SELECT", () => {
    expect(checkSqlQuery("SELECT id FROM memories WHERE id = 1").ok).toBe(true);
  });

  it("accepts a WITH clause", () => {
    expect(checkSqlQuery("WITH x AS (SELECT 1 AS n) SELECT n FROM x").ok).toBe(true);
  });

  it("accepts a trailing semicolon", () => {
    expect(checkSqlQuery("SELECT 1;").ok).toBe(true);
  });

  it("rejects INSERT/UPDATE/DELETE", () => {
    expect(checkSqlQuery("INSERT INTO memories(content) VALUES('x')").ok).toBe(false);
    expect(checkSqlQuery("UPDATE memories SET content='x'").ok).toBe(false);
    expect(checkSqlQuery("DELETE FROM memories").ok).toBe(false);
  });

  it("rejects multiple statements", () => {
    expect(checkSqlQuery("SELECT 1; DROP TABLE memories").ok).toBe(false);
  });

  it("rejects ATTACH and PRAGMA assignment", () => {
    expect(checkSqlQuery("ATTACH DATABASE 'other.db' AS x").ok).toBe(false);
    expect(checkSqlQuery("SELECT 1; PRAGMA writable_schema = ON").ok).toBe(false);
  });

  it("rejects empty / non-string", () => {
    expect(checkSqlQuery("").ok).toBe(false);
    expect(checkSqlQuery("   -- comment only\n  ").ok).toBe(false);
    expect(checkSqlQuery(42 as unknown as string).ok).toBe(false);
  });
});
