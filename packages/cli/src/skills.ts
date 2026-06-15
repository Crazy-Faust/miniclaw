import { join } from "node:path";
import { SkillRegistry } from "@miniclaw/core";
import {
  BUILTIN_SKILLS_DIR,
  loadAgentSkills,
  type DiscoverDiagnostic,
  type SkillDir,
} from "@miniclaw/agent-skills";

export interface LoadSkillsOptions {
  /** MINICLAW_HOME — its `skills/` subdir is scanned as the user scope (trusted). */
  home?: string;
  /** Workspace root — its `skills/` subdir is scanned as the project scope (untrusted). */
  workspaceRoot?: string;
  /** Defaults to process.env. Gates the web skills and feeds built-in factories. */
  env?: NodeJS.ProcessEnv;
}

export interface LoadedSkills {
  registry: SkillRegistry;
  /** System-prompt catalog section for the discovered skills ("" when none). */
  catalog: string;
  /** Summary of every discovered SKILL.md skill (for the /skills command). */
  skills: Array<{ name: string; description: string; scope: string }>;
  diagnostics: DiscoverDiagnostic[];
}

// The single place where built-in skills are stitched together. Skills are
// discovered as agentskills.io SKILL.md folders: bundled built-ins ship in
// @miniclaw/agent-skills and are backed by in-process handlers (shell,
// filesystem, database, web, memory); user ($MINICLAW_HOME/skills) and
// workspace skills are discovered for the catalog + use_skill + run_skill_script.
//
// Runtime-bound skills (sessions, cron, canvas, dream, wiki) are registered by
// the caller (main.ts / daemon.ts) once their stores/gateways exist.
export function loadSkills(opts: LoadSkillsOptions = {}): LoadedSkills {
  const env = opts.env ?? process.env;

  const dirs: SkillDir[] = [{ path: BUILTIN_SKILLS_DIR, scope: "bundled", trusted: true }];
  if (opts.home) dirs.push({ path: join(opts.home, "skills"), scope: "user", trusted: true });
  if (opts.workspaceRoot) {
    dirs.push({ path: join(opts.workspaceRoot, "skills"), scope: "workspace", trusted: false });
  }

  const agentSkills = loadAgentSkills({ dirs, env });

  const registry = new SkillRegistry();
  // Handler-backed built-in tools discovered from bundled SKILL.md folders.
  for (const tool of agentSkills.tools) registry.register(tool);
  // Skill activation + bundled-script execution.
  if (agentSkills.useSkillTool) registry.register(agentSkills.useSkillTool);
  if (agentSkills.runScriptTool) registry.register(agentSkills.runScriptTool);

  const skills = agentSkills.skills.map((s) => ({
    name: s.name,
    description: s.description,
    scope: s.scope,
  }));

  return { registry, catalog: agentSkills.catalog, skills, diagnostics: agentSkills.diagnostics };
}
