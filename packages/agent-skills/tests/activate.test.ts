import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillContext } from "@miniclaw/core";
import { createUseSkillTool } from "../src/activate.ts";
import type { LoadedSkill } from "../src/discover.ts";

let root: string;
let skill: LoadedSkill;

const ctx = {} as unknown as SkillContext; // use_skill ignores ctx

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "activate-"));
  const dir = join(root, "demo");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: demo\ndescription: A demo.\n---\nHello body.\n");
  writeFileSync(join(dir, "scripts", "run.py"), "print('hi')\n");
  writeFileSync(join(dir, "scripts", "handler.ts"), "export const x = 1;\n");
  writeFileSync(join(dir, "references", "REF.md"), "# Ref\n");
  skill = {
    name: "demo",
    description: "A demo.",
    dir,
    skillMdPath: join(dir, "SKILL.md"),
    body: "Hello body.",
    manifest: { name: "demo", description: "A demo." },
    scope: "user",
    trusted: true,
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createUseSkillTool", () => {
  it("returns the SKILL.md body wrapped in <skill_content> and lists resources", async () => {
    const tool = createUseSkillTool([skill]);
    const res = await tool.execute({ name: "demo" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain('<skill_content name="demo">');
    expect(res.output).toContain("Hello body.");
    expect(res.output).toContain("Skill directory:");
    expect(res.output).toContain("scripts/run.py");
    expect(res.output).toContain("references/REF.md");
  });

  it("does not list the reserved handler entry as a runnable resource", async () => {
    const tool = createUseSkillTool([skill]);
    const res = await tool.execute({ name: "demo" }, ctx);
    expect(res.output).not.toContain("handler.ts");
  });

  it("fails for an unknown skill name", async () => {
    const tool = createUseSkillTool([skill]);
    const res = await tool.execute({ name: "nope" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain("unknown skill");
  });

  it("re-reads the body from disk so edits are picked up", async () => {
    const tool = createUseSkillTool([skill]);
    writeFileSync(skill.skillMdPath, "---\nname: demo\ndescription: A demo.\n---\nEdited body.\n");
    const res = await tool.execute({ name: "demo" }, ctx);
    expect(res.output).toContain("Edited body.");
  });
});
