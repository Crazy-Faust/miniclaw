import { describe, expect, it } from "vitest";
import { checkShellCall } from "../src/lib/shell-security.ts";

// VULN-04: git subcommand restrictions
describe("checkShellCall — git subcommand allowlist (VULN-04)", () => {
  it("allows read-only git subcommands", () => {
    expect(checkShellCall("git", ["status"]).ok).toBe(true);
    expect(checkShellCall("git", ["log", "--oneline"]).ok).toBe(true);
    expect(checkShellCall("git", ["diff"]).ok).toBe(true);
    expect(checkShellCall("git", ["show", "HEAD"]).ok).toBe(true);
    expect(checkShellCall("git", ["branch"]).ok).toBe(true);
    expect(checkShellCall("git", ["tag"]).ok).toBe(true);
    expect(checkShellCall("git", ["blame", "file.ts"]).ok).toBe(true);
    expect(checkShellCall("git", ["ls-files"]).ok).toBe(true);
    expect(checkShellCall("git", ["rev-parse", "HEAD"]).ok).toBe(true);
  });

  it("rejects disallowed git subcommands", () => {
    const r1 = checkShellCall("git", ["clone", "https://evil.com/repo"]);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toMatch(/not allowed/);

    const r2 = checkShellCall("git", ["push"]);
    expect(r2.ok).toBe(false);

    const r3 = checkShellCall("git", ["pull"]);
    expect(r3.ok).toBe(false);

    const r4 = checkShellCall("git", ["config", "--global", "user.name", "evil"]);
    expect(r4.ok).toBe(false);

    const r5 = checkShellCall("git", ["checkout", "main"]);
    expect(r5.ok).toBe(false);

    const r6 = checkShellCall("git", ["reset", "--hard"]);
    expect(r6.ok).toBe(false);

    const r7 = checkShellCall("git", ["rm", "file.ts"]);
    expect(r7.ok).toBe(false);
  });

  it("rejects git -c flag (arbitrary config injection)", () => {
    const r = checkShellCall("git", ["-c", "core.sshCommand=evil", "clone", "repo"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/forbidden/);
  });

  it("rejects git --exec-path flag", () => {
    const r = checkShellCall("git", ["--exec-path=/tmp/evil", "status"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/forbidden/);
  });

  it("rejects git --global flag", () => {
    const r = checkShellCall("git", ["--global", "status"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/forbidden/);
  });

  it("rejects git with no subcommand", () => {
    const r = checkShellCall("git", []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/requires a subcommand/);
  });

  it("rejects git with only flags (no subcommand)", () => {
    const r = checkShellCall("git", ["--no-pager"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/requires a subcommand/);
  });

  it("allows git with leading --no-pager before allowed subcommand", () => {
    const r = checkShellCall("git", ["--no-pager", "log", "--oneline"]);
    expect(r.ok).toBe(true);
  });
});

// VULN-05: find dangerous argument restrictions
describe("checkShellCall — find dangerous args (VULN-05)", () => {
  it("allows safe find usage", () => {
    expect(checkShellCall("find", [".", "-name", "*.ts"]).ok).toBe(true);
    expect(checkShellCall("find", [".", "-type", "f"]).ok).toBe(true);
    expect(checkShellCall("find", [".", "-maxdepth", "2"]).ok).toBe(true);
  });

  it("rejects find -exec", () => {
    const r = checkShellCall("find", [".", "-name", "*.ts", "-exec", "rm", "{}", ";"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/forbidden/);
  });

  it("rejects find -execdir", () => {
    const r = checkShellCall("find", [".", "-execdir", "cat", "{}", ";"]);
    expect(r.ok).toBe(false);
  });

  it("rejects find -delete", () => {
    const r = checkShellCall("find", [".", "-name", "*.log", "-delete"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/forbidden/);
  });

  it("rejects find -ok", () => {
    const r = checkShellCall("find", [".", "-ok", "rm", "{}", ";"]);
    expect(r.ok).toBe(false);
  });

  it("rejects find -okdir", () => {
    const r = checkShellCall("find", [".", "-okdir", "cat", "{}", ";"]);
    expect(r.ok).toBe(false);
  });
});
