import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSkillMd, validateManifest } from "@miniclaw/agent-skills";
import { createSkillFolder, type SkillSpec } from "../src/make-skill/index.ts";

const SPEC: SkillSpec = {
  name: "pdf-tools",
  description: "Work with PDFs.",
  script: { language: "python", fileName: "extract.py" },
};

describe("createSkillFolder", () => {
  let skillsDir: string;

  beforeEach(() => {
    skillsDir = mkdtempSync(join(tmpdir(), "miniclaw-make-skill-"));
  });
  afterEach(() => {
    rmSync(skillsDir, { recursive: true, force: true });
  });

  it("creates the skill folder with SKILL.md and the bundled script", () => {
    const res = createSkillFolder(SPEC, skillsDir);
    expect(res.skillDir).toBe(join(skillsDir, "pdf-tools"));
    expect(res.files).toEqual(["SKILL.md", "scripts/extract.py"]);
    expect(existsSync(join(res.skillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(res.skillDir, "scripts", "extract.py"))).toBe(true);
  });

  it("creates only SKILL.md when no script is requested", () => {
    const res = createSkillFolder({ name: "notes", description: "Take notes." }, skillsDir);
    expect(res.files).toEqual(["SKILL.md"]);
    expect(existsSync(join(res.skillDir, "scripts"))).toBe(false);
  });

  it("emits frontmatter the loader accepts (round-trip)", () => {
    const res = createSkillFolder(SPEC, skillsDir);
    const md = readFileSync(join(res.skillDir, "SKILL.md"), "utf8");
    const parsed = parseSkillMd(md);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    const { manifest, diagnostics } = validateManifest(parsed.frontmatter, "pdf-tools");
    expect(manifest?.name).toBe("pdf-tools");
    expect(manifest?.description).toBe("Work with PDFs.");
    expect(diagnostics).toHaveLength(0);
  });

  it("refuses to overwrite an existing skill folder", () => {
    createSkillFolder(SPEC, skillsDir);
    expect(() => createSkillFolder(SPEC, skillsDir)).toThrow(/already exists/);
  });
});
