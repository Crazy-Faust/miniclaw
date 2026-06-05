import { describe, expect, it } from "vitest";
import {
  camelize,
  indexTsContent,
  packageJsonContent,
  skillTsContent,
  testTsContent,
  tsconfigContent,
  type SkillSpec,
} from "../src/make-skill/index.ts";

function makeSpec(over: Partial<SkillSpec> = {}): SkillSpec {
  return {
    pkgName: "fetch-url",
    toolName: "fetch_url",
    description: "Fetch a URL.",
    params: [
      { name: "url", type: "string", optional: false },
      { name: "timeout", type: "number", optional: true },
    ],
    ...over,
  };
}

describe("camelize", () => {
  it("turns snake_case into camelCase", () => {
    expect(camelize("fetch_url")).toBe("fetchUrl");
    expect(camelize("a")).toBe("a");
    expect(camelize("a_b_c")).toBe("aBC");
  });
  it("handles kebab-case too", () => {
    expect(camelize("fetch-url")).toBe("fetchUrl");
  });
});

describe("packageJsonContent", () => {
  it("emits a parseable JSON with the expected name and deps", () => {
    const j = JSON.parse(packageJsonContent(makeSpec()));
    expect(j.name).toBe("@miniclaw/skills-fetch-url");
    expect(j.dependencies["@miniclaw/core"]).toBe("workspace:*");
    expect(j.dependencies.zod).toBeTruthy();
    expect(j.scripts.test).toBe("vitest run");
  });
});

describe("tsconfigContent", () => {
  it("extends the workspace base config", () => {
    const j = JSON.parse(tsconfigContent());
    expect(j.extends).toBe("../../tsconfig.base.json");
    expect(j.include).toContain("src/**/*.ts");
  });
});

describe("skillTsContent", () => {
  it("includes the expected exports, name, and description", () => {
    const src = skillTsContent(makeSpec());
    expect(src).toContain("export const fetchUrlSkill");
    expect(src).toContain('name: "fetch_url"');
    expect(src).toContain('description: "Fetch a URL."');
  });

  it("translates each param into a zod field", () => {
    const src = skillTsContent(makeSpec());
    expect(src).toMatch(/url:\s*z\.string\(\)\.describe/);
    expect(src).toMatch(/timeout:\s*z\.number\(\)\.optional\(\)\.describe/);
  });

  it("emits a placeholder body that returns fail('not implemented')", () => {
    const src = skillTsContent(makeSpec());
    expect(src).toContain('return fail("not implemented")');
  });

  it("handles the zero-params case without breaking the file", () => {
    const src = skillTsContent(makeSpec({ params: [] }));
    expect(src).toContain("// No parameters");
    expect(src).toContain("export const fetchUrlSkill");
  });
});

describe("indexTsContent", () => {
  it("re-exports the named skill", () => {
    expect(indexTsContent(makeSpec())).toBe(
      'export { fetchUrlSkill } from "./skill.ts";\n',
    );
  });
});

describe("testTsContent", () => {
  it("imports the skill and asserts its name", () => {
    const src = testTsContent(makeSpec());
    expect(src).toContain('import { fetchUrlSkill }');
    expect(src).toMatch(/expect\(fetchUrlSkill\.name\)\.toBe\("fetch_url"\)/);
    expect(src).toContain("it.todo");
  });
});
