import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSkillPackage,
  patchCliPackageJson,
  patchCliSkills,
  type SkillSpec,
} from "../src/make-skill/index.ts";

const SPEC: SkillSpec = {
  pkgName: "fetch-url",
  toolName: "fetch_url",
  description: "Fetch a URL.",
  params: [{ name: "url", type: "string", optional: false }],
};

// Build a minimal fake repo that has the shape the patcher expects.
function setupFakeRepo(root: string): void {
  mkdirSync(join(root, "packages", "cli", "src"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  writeFileSync(
    join(root, "packages", "cli", "src", "skills.ts"),
    `import { SkillRegistry } from "@miniclaw/core";
import { sqlQuerySkill } from "@miniclaw/skills-db";
import { shellSkill } from "@miniclaw/skills-shell";

export function buildRegistry(): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register(shellSkill);
  registry.register(sqlQuerySkill);
  return registry;
}
`,
  );
  writeFileSync(
    join(root, "packages", "cli", "package.json"),
    JSON.stringify({
      name: "@miniclaw/cli",
      dependencies: {
        "@miniclaw/skills-db": "workspace:*",
        "@miniclaw/skills-shell": "workspace:*",
      },
    }, null, 2),
  );
}

describe("createSkillPackage", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "miniclaw-make-skill-"));
    setupFakeRepo(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates the package directory and the five expected files", () => {
    const res = createSkillPackage(SPEC, root);
    const dir = join(root, "packages", "skills-fetch-url");
    expect(res.packageDir).toBe(dir);
    for (const f of ["package.json", "tsconfig.json", "src/skill.ts", "src/index.ts", "tests/skill.test.ts"]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
  });

  it("refuses to overwrite an existing package", () => {
    createSkillPackage(SPEC, root);
    expect(() => createSkillPackage(SPEC, root)).toThrow(/already exists/);
  });

  it("the emitted skill.ts mentions the camelized export name", () => {
    createSkillPackage(SPEC, root);
    const skillTs = readFileSync(
      join(root, "packages", "skills-fetch-url", "src", "skill.ts"),
      "utf8",
    );
    expect(skillTs).toContain("export const fetchUrlSkill");
  });
});

describe("patchCliSkills", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "miniclaw-make-skill-patch-"));
    setupFakeRepo(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("inserts the import and the register call exactly once", () => {
    const res = patchCliSkills(SPEC, root);
    expect(res.changed).toBe(true);

    const after = readFileSync(join(root, "packages", "cli", "src", "skills.ts"), "utf8");
    expect(after).toContain('import { fetchUrlSkill } from "@miniclaw/skills-fetch-url"');
    expect(after).toContain("registry.register(fetchUrlSkill);");

    // The register call should be BEFORE `return registry;`.
    const registerIdx = after.indexOf("registry.register(fetchUrlSkill);");
    const returnIdx = after.indexOf("return registry;");
    expect(registerIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeGreaterThan(registerIdx);
  });

  it("is idempotent (running twice doesn't double-register)", () => {
    patchCliSkills(SPEC, root);
    const second = patchCliSkills(SPEC, root);
    expect(second.changed).toBe(false);

    const after = readFileSync(join(root, "packages", "cli", "src", "skills.ts"), "utf8");
    const occurrences = after.match(/fetchUrlSkill/g)?.length ?? 0;
    // expected: 1 import + 1 register
    expect(occurrences).toBe(2);
  });
});

describe("patchCliPackageJson", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "miniclaw-make-skill-pkg-"));
    setupFakeRepo(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("adds the new workspace dependency", () => {
    const res = patchCliPackageJson(SPEC, root);
    expect(res.changed).toBe(true);

    const after = JSON.parse(
      readFileSync(join(root, "packages", "cli", "package.json"), "utf8"),
    );
    expect(after.dependencies["@miniclaw/skills-fetch-url"]).toBe("workspace:*");
  });

  it("keeps dependency keys alphabetically sorted", () => {
    patchCliPackageJson(SPEC, root);
    const after = JSON.parse(
      readFileSync(join(root, "packages", "cli", "package.json"), "utf8"),
    );
    const keys = Object.keys(after.dependencies);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it("is idempotent", () => {
    patchCliPackageJson(SPEC, root);
    const second = patchCliPackageJson(SPEC, root);
    expect(second.changed).toBe(false);
  });
});
