import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillContext } from "@miniclaw/core";
import { createRunSkillScriptTool, runnableSkills } from "../src/run-script.ts";
import type { LoadedSkill } from "../src/discover.ts";

let root: string;
let skill: LoadedSkill;

const ctx = {} as unknown as SkillContext; // run_skill_script only reads ctx.onStream

function loaded(dir: string, name = "demo"): LoadedSkill {
  return {
    name,
    description: "d",
    dir,
    skillMdPath: join(dir, "SKILL.md"),
    body: "",
    manifest: { name, description: "d" },
    scope: "user",
    trusted: true,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runscript-"));
  const dir = join(root, "demo");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "echo.mjs"), "console.log('hello ' + (process.argv[2] ?? ''));\n");
  writeFileSync(join(dir, "scripts", "big.mjs"), "console.log('x'.repeat(10000));\n");
  writeFileSync(join(dir, "scripts", "sleeper.mjs"), "setTimeout(() => {}, 10000);\n");
  writeFileSync(join(dir, "scripts", "notes.rb"), "puts 'nope'\n");
  writeFileSync(join(dir, "scripts", "handler.ts"), "export const x = 1;\n");
  // A sibling file outside scripts/, used for the escape test.
  writeFileSync(join(dir, "secret.mjs"), "console.log('secret');\n");
  skill = loaded(dir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createRunSkillScriptTool", () => {
  it("runs an allowlisted .mjs script and returns its stdout", async () => {
    const tool = createRunSkillScriptTool([skill]);
    const res = await tool.execute({ skill: "demo", script: "scripts/echo.mjs", args: ["world"] }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain("hello world");
    expect(res.output).toContain("exit_code=0");
  });

  it("refuses a script path that escapes the skill directory", async () => {
    const tool = createRunSkillScriptTool([skill]);
    const res = await tool.execute({ skill: "demo", script: "../secret.mjs", args: [] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("outside the skill directory");
  });

  it("refuses an absolute path outside the skill directory", async () => {
    const tool = createRunSkillScriptTool([skill]);
    const res = await tool.execute({ skill: "demo", script: "/etc/hosts", args: [] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("outside the skill directory");
  });

  it("refuses an extension with no interpreter", async () => {
    const tool = createRunSkillScriptTool([skill]);
    const res = await tool.execute({ skill: "demo", script: "scripts/notes.rb", args: [] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("no interpreter");
  });

  it("refuses the reserved handler entry point", async () => {
    const tool = createRunSkillScriptTool([skill]);
    const res = await tool.execute({ skill: "demo", script: "scripts/handler.ts", args: [] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("handler");
  });

  it("fails when the script does not exist", async () => {
    const tool = createRunSkillScriptTool([skill]);
    const res = await tool.execute({ skill: "demo", script: "scripts/missing.mjs", args: [] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("not found");
  });

  it("kills the process and reports a timeout", async () => {
    const tool = createRunSkillScriptTool([skill], { timeoutMs: 200 });
    const res = await tool.execute({ skill: "demo", script: "scripts/sleeper.mjs", args: [] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("timeout after 200ms");
  });

  it("truncates output past the byte cap", async () => {
    const tool = createRunSkillScriptTool([skill], { maxOutputBytes: 64 });
    const res = await tool.execute({ skill: "demo", script: "scripts/big.mjs", args: [] }, ctx);
    expect(res.output).toContain("output truncated");
  });

  it("fails for an unknown skill name", async () => {
    const tool = createRunSkillScriptTool([skill]);
    const res = await tool.execute({ skill: "ghost", script: "scripts/echo.mjs", args: [] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("unknown skill");
  });
});

describe("runnableSkills", () => {
  it("includes a skill that bundles an allowlisted script", () => {
    expect(runnableSkills([skill]).map((s) => s.name)).toEqual(["demo"]);
  });

  it("excludes a skill whose only script is the reserved handler", () => {
    const dir = join(root, "handler-only");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "handler.ts"), "export const x = 1;\n");
    expect(runnableSkills([loaded(dir, "handler-only")])).toHaveLength(0);
  });
});
