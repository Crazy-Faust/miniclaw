import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  indexTsContent,
  packageJsonContent,
  skillTsContent,
  testTsContent,
  tsconfigContent,
  camelize,
  type SkillSpec,
} from "./templates.ts";

// ---- Repo discovery ----

/**
 * Walk up from `start` until we find a directory containing pnpm-workspace.yaml.
 * That's the repo root. Throws if not found.
 */
export function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find pnpm-workspace.yaml starting from ${start}`);
}

export function defaultRepoRoot(): string {
  // cli/src/make-skill/files.ts → walk up to find pnpm-workspace.yaml.
  return findRepoRoot(dirname(fileURLToPath(import.meta.url)));
}

// ---- Package creation ----

export interface CreateResult {
  packageDir: string;
  files: string[];
}

/**
 * Create packages/skills-<pkgName>/ with the templated files.
 * Throws if the directory already exists (no clobbering by default).
 */
export function createSkillPackage(spec: SkillSpec, repoRoot: string): CreateResult {
  const packageDir = join(repoRoot, "packages", `skills-${spec.pkgName}`);
  if (existsSync(packageDir)) {
    throw new Error(`directory already exists: ${packageDir}`);
  }
  mkdirSync(join(packageDir, "src"), { recursive: true });
  mkdirSync(join(packageDir, "tests"), { recursive: true });

  const files: Array<[string, string]> = [
    ["package.json", packageJsonContent(spec)],
    ["tsconfig.json", tsconfigContent()],
    ["src/skill.ts", skillTsContent(spec)],
    ["src/index.ts", indexTsContent(spec)],
    ["tests/skill.test.ts", testTsContent(spec)],
  ];
  for (const [rel, content] of files) {
    writeFileSync(join(packageDir, rel), content);
  }
  return { packageDir, files: files.map(([rel]) => rel) };
}

// ---- CLI registration patcher ----

/**
 * Patch cli/src/skills.ts: add an import for the new package and a
 * registry.register(...) call. Idempotent — won't double-register.
 */
export function patchCliSkills(spec: SkillSpec, repoRoot: string): { changed: boolean } {
  const skillsPath = join(repoRoot, "packages", "cli", "src", "skills.ts");
  if (!existsSync(skillsPath)) throw new Error(`missing ${skillsPath}`);

  const src = readFileSync(skillsPath, "utf8");
  const pkg = `@miniclaw/skills-${spec.pkgName}`;
  const exportName = camelize(spec.toolName) + "Skill";

  if (src.includes(pkg)) return { changed: false };

  // 1) Append a new import line after the last existing `@miniclaw/skills-*` import.
  const importLines = src.split("\n");
  let lastImportIdx = -1;
  for (let i = 0; i < importLines.length; i++) {
    if (/^import .* from "@miniclaw\/skills-/.test(importLines[i] ?? "")) {
      lastImportIdx = i;
    }
  }
  if (lastImportIdx === -1) {
    throw new Error("could not find any @miniclaw/skills-* import to anchor against");
  }
  const newImport = `import { ${exportName} } from "${pkg}";`;
  importLines.splice(lastImportIdx + 1, 0, newImport);

  // 2) Append a register call before the final `return registry;`.
  let patched = importLines.join("\n");
  const returnRegex = /(\n\s*return\s+registry\s*;)/;
  const m = returnRegex.exec(patched);
  if (!m) throw new Error("could not find 'return registry;' in skills.ts");
  patched = patched.replace(returnRegex, `\n  registry.register(${exportName});$1`);

  writeFileSync(skillsPath, patched);
  return { changed: true };
}

/**
 * Patch cli/package.json: add the new workspace package as a dependency.
 * Idempotent.
 */
export function patchCliPackageJson(spec: SkillSpec, repoRoot: string): { changed: boolean } {
  const pkgPath = join(repoRoot, "packages", "cli", "package.json");
  const json = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const depName = `@miniclaw/skills-${spec.pkgName}`;
  if (json.dependencies && json.dependencies[depName]) return { changed: false };

  const deps = json.dependencies ?? {};
  deps[depName] = "workspace:*";
  // Re-sort to keep the file tidy.
  const sorted = Object.fromEntries(
    Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)),
  );
  json.dependencies = sorted;
  writeFileSync(pkgPath, JSON.stringify(json, null, 2) + "\n");
  return { changed: true };
}
