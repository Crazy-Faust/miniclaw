import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scriptStubContent, skillMdContent, type SkillSpec } from "./templates.ts";

/**
 * Default location to scaffold into: the workspace's `skills/` directory, which
 * the loader scans at startup. (It also scans `$MINICLAW_HOME/skills`; move the
 * folder there for cross-project use.)
 */
export function defaultSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  const workspace = resolve(env.MINICLAW_WORKSPACE ?? process.cwd());
  return join(workspace, "skills");
}

export interface CreateResult {
  skillDir: string;
  files: string[];
}

/**
 * Create `<skillsDir>/<name>/` with a SKILL.md and, if requested, a bundled
 * script under scripts/. Throws if the directory already exists (no clobber).
 */
export function createSkillFolder(spec: SkillSpec, skillsDir: string): CreateResult {
  const skillDir = join(skillsDir, spec.name);
  if (existsSync(skillDir)) {
    throw new Error(`directory already exists: ${skillDir}`);
  }
  mkdirSync(skillDir, { recursive: true });

  const files: Array<[string, string]> = [["SKILL.md", skillMdContent(spec)]];
  if (spec.script) {
    mkdirSync(join(skillDir, "scripts"), { recursive: true });
    files.push([`scripts/${spec.script.fileName}`, scriptStubContent(spec.script.language)]);
  }

  for (const [rel, content] of files) {
    const abs = join(skillDir, rel);
    writeFileSync(abs, content);
    if (rel.startsWith("scripts/")) {
      // Best-effort: make bundled scripts executable so they can also be run
      // directly outside the run_skill_script sandbox during development.
      try {
        chmodSync(abs, 0o755);
      } catch {
        // non-fatal (e.g. on filesystems without POSIX modes)
      }
    }
  }

  return { skillDir, files: files.map(([rel]) => rel) };
}
