import { describe, expect, it } from "vitest";
import {
  defaultScriptFileName,
  scriptStubContent,
  skillMdContent,
  titleCase,
  type SkillSpec,
} from "../src/make-skill/index.ts";

function makeSpec(over: Partial<SkillSpec> = {}): SkillSpec {
  return { name: "pdf-tools", description: "Work with PDFs.", ...over };
}

describe("skillMdContent", () => {
  it("emits YAML frontmatter with the name and description", () => {
    const md = skillMdContent(makeSpec());
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("name: pdf-tools");
    expect(md).toContain("description: Work with PDFs.");
    expect(md).toContain("# Pdf Tools");
  });

  it("adds a scripts section when a script is bundled", () => {
    const md = skillMdContent(makeSpec({ script: { language: "python", fileName: "extract.py" } }));
    expect(md).toContain("## Scripts");
    expect(md).toContain("run_skill_script");
    expect(md).toContain('script="scripts/extract.py"');
  });

  it("omits the scripts section when there is no script", () => {
    expect(skillMdContent(makeSpec())).not.toContain("run_skill_script");
  });
});

describe("scriptStubContent", () => {
  it("emits a python stub with a shebang and main()", () => {
    const s = scriptStubContent("python");
    expect(s).toContain("#!/usr/bin/env python3");
    expect(s).toContain("def main(");
  });

  it("emits a node stub that reads argv", () => {
    expect(scriptStubContent("node")).toContain("process.argv");
  });

  it("emits a bash stub", () => {
    expect(scriptStubContent("bash")).toContain("#!/usr/bin/env bash");
  });
});

describe("defaultScriptFileName", () => {
  it("maps the language to a sensible default file name", () => {
    expect(defaultScriptFileName("python")).toBe("run.py");
    expect(defaultScriptFileName("node")).toBe("run.mjs");
    expect(defaultScriptFileName("bash")).toBe("run.sh");
  });
});

describe("titleCase", () => {
  it("turns a kebab-case name into a title", () => {
    expect(titleCase("pdf-tools")).toBe("Pdf Tools");
    expect(titleCase("x")).toBe("X");
  });
});
