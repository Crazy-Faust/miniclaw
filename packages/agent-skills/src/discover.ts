import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  parseSkillMd,
  validateManifest,
  type Diagnostic,
  type SkillManifest,
} from "./manifest.ts";

export type SkillScope = "bundled" | "user" | "workspace";

export interface SkillDir {
  /** Absolute path to a directory that contains skill subdirectories. */
  path: string;
  scope: SkillScope;
  /**
   * Whether skills from this dir may be backed by in-process handler code.
   * Bundled (first-party) and user-owned dirs are trusted; a project/workspace
   * dir may be an untrusted clone, so its skills are instruction-only.
   */
  trusted: boolean;
}

export interface LoadedSkill {
  name: string;
  description: string;
  /** Absolute path to the skill directory. */
  dir: string;
  /** Absolute path to the SKILL.md file. */
  skillMdPath: string;
  /** Markdown body (instructions) after the frontmatter. */
  body: string;
  manifest: SkillManifest;
  scope: SkillScope;
  trusted: boolean;
}

export interface DiscoverDiagnostic {
  path: string;
  diagnostics: Diagnostic[];
}

export interface DiscoverResult {
  skills: LoadedSkill[];
  diagnostics: DiscoverDiagnostic[];
}

// Project-level skills win over user-level, which win over bundled — the
// universal convention noted in the agentskills.io client guide.
const SCOPE_RANK: Record<SkillScope, number> = { workspace: 3, user: 2, bundled: 1 };

/**
 * Scan each directory's immediate subdirectories for a SKILL.md, parse + validate them,
 * and return the de-duplicated set (higher-scope skills shadow lower-scope ones
 * of the same name). Missing directories are skipped silently.
 */
export function discoverSkills(dirs: SkillDir[]): DiscoverResult {
  const byName = new Map<string, LoadedSkill>();
  const diagnostics: DiscoverDiagnostic[] = [];

  for (const d of dirs) {
    if (!existsSync(d.path)) continue;
    let entries: string[];
    try {
      entries = readdirSync(d.path);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const skillDir = join(d.path, entry);
      try {
        if (!statSync(skillDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const skillMdPath = join(skillDir, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;

      let raw: string;
      try {
        raw = readFileSync(skillMdPath, "utf8");
      } catch (err) {
        diagnostics.push({
          path: skillMdPath,
          diagnostics: [{ level: "error", message: `read failed: ${(err as Error).message}` }],
        });
        continue;
      }

      const parsed = parseSkillMd(raw);
      if ("error" in parsed) {
        diagnostics.push({ path: skillMdPath, diagnostics: [{ level: "error", message: parsed.error }] });
        continue;
      }
      const { manifest, diagnostics: vdiags } = validateManifest(parsed.frontmatter, entry);
      if (vdiags.length) diagnostics.push({ path: skillMdPath, diagnostics: vdiags });
      if (!manifest) continue;

      const loaded: LoadedSkill = {
        name: manifest.name,
        description: manifest.description,
        dir: skillDir,
        skillMdPath,
        body: parsed.body,
        manifest,
        scope: d.scope,
        trusted: d.trusted,
      };

      const existing = byName.get(manifest.name);
      if (!existing) {
        byName.set(manifest.name, loaded);
        continue;
      }
      if (SCOPE_RANK[d.scope] >= SCOPE_RANK[existing.scope]) {
        diagnostics.push({
          path: skillMdPath,
          diagnostics: [{ level: "warn", message: `shadows skill '${manifest.name}' from ${existing.scope} scope` }],
        });
        byName.set(manifest.name, loaded);
      } else {
        diagnostics.push({
          path: skillMdPath,
          diagnostics: [{ level: "warn", message: `skill '${manifest.name}' is shadowed by ${existing.scope} scope` }],
        });
      }
    }
  }

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills, diagnostics };
}
