import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills, type SkillDir } from "../src/discover.ts";

let root: string;
let bundled: string;
let workspace: string;

function writeSkill(dir: string, name: string, frontmatter: string, body = "Instructions."): void {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "discover-"));
  bundled = join(root, "bundled");
  workspace = join(root, "workspace");
  mkdirSync(bundled, { recursive: true });
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("discoverSkills", () => {
  it("discovers valid SKILL.md folders and ignores non-skill dirs", () => {
    writeSkill(bundled, "alpha", "name: alpha\ndescription: Alpha skill.");
    mkdirSync(join(bundled, "not-a-skill"), { recursive: true }); // no SKILL.md
    writeFileSync(join(bundled, "README.md"), "ignored");

    const { skills } = discoverSkills([{ path: bundled, scope: "bundled", trusted: true }]);
    expect(skills.map((s) => s.name)).toEqual(["alpha"]);
    expect(skills[0]?.scope).toBe("bundled");
    expect(skills[0]?.body).toBe("Instructions.");
  });

  it("skips hidden and node_modules directories", () => {
    writeSkill(bundled, ".hidden", "name: hidden\ndescription: d");
    writeSkill(bundled, "node_modules", "name: nm\ndescription: d");
    writeSkill(bundled, "real", "name: real\ndescription: d");
    const { skills } = discoverSkills([{ path: bundled, scope: "bundled", trusted: true }]);
    expect(skills.map((s) => s.name)).toEqual(["real"]);
  });

  it("records a diagnostic and skips a SKILL.md with no frontmatter", () => {
    const d = join(bundled, "broken");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), "no frontmatter here");
    const { skills, diagnostics } = discoverSkills([{ path: bundled, scope: "bundled", trusted: true }]);
    expect(skills).toHaveLength(0);
    expect(diagnostics.some((g) => g.diagnostics.some((x) => x.level === "error"))).toBe(true);
  });

  it("lets a workspace skill shadow a bundled skill of the same name", () => {
    writeSkill(bundled, "shared", "name: shared\ndescription: bundled version", "BUNDLED");
    writeSkill(workspace, "shared", "name: shared\ndescription: workspace version", "WORKSPACE");
    const dirs: SkillDir[] = [
      { path: bundled, scope: "bundled", trusted: true },
      { path: workspace, scope: "workspace", trusted: false },
    ];
    const { skills, diagnostics } = discoverSkills(dirs);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.scope).toBe("workspace");
    expect(skills[0]?.body).toBe("WORKSPACE");
    expect(diagnostics.some((g) => g.diagnostics.some((x) => /shadow/.test(x.message)))).toBe(true);
  });

  it("returns nothing for a missing directory without throwing", () => {
    const { skills } = discoverSkills([{ path: join(root, "nope"), scope: "user", trusted: true }]);
    expect(skills).toEqual([]);
  });
});
