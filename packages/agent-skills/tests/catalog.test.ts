import { describe, expect, it } from "vitest";
import { formatSkillCatalog } from "../src/catalog.ts";
import type { LoadedSkill } from "../src/discover.ts";

function skill(name: string, description: string): LoadedSkill {
  return {
    name,
    description,
    dir: `/skills/${name}`,
    skillMdPath: `/skills/${name}/SKILL.md`,
    body: "",
    manifest: { name, description },
    scope: "bundled",
    trusted: true,
  };
}

describe("formatSkillCatalog", () => {
  it("returns an empty string when there are no skills", () => {
    expect(formatSkillCatalog([])).toBe("");
  });

  it("lists each skill's name, description, and location", () => {
    const out = formatSkillCatalog([skill("filesystem", "Read and write files.")]);
    expect(out).toContain("<available_skills>");
    expect(out).toContain("<name>filesystem</name>");
    expect(out).toContain("<description>Read and write files.</description>");
    expect(out).toContain("<location>/skills/filesystem/SKILL.md</location>");
    expect(out).toContain("use_skill");
  });

  it("escapes XML metacharacters in descriptions", () => {
    const out = formatSkillCatalog([skill("html", "Handles <tags> & entities")]);
    expect(out).toContain("Handles &lt;tags&gt; &amp; entities");
    expect(out).not.toContain("<tags>");
  });
});
