import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../src/index.ts";

// VULN-15: SQLite database file permissions
describe("SqliteStore — file permissions (VULN-15)", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-perm-test-"));
    store = new SqliteStore(join(dir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sets database file permissions to 0600 (owner-only)", () => {
    const stat = statSync(join(dir, "test.db"));
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
