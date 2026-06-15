import { fileURLToPath } from "node:url";
import type { Skill } from "@miniclaw/core";
import { discoverSkills, type DiscoverDiagnostic, type LoadedSkill, type SkillDir } from "./discover.ts";
import { formatSkillCatalog } from "./catalog.ts";
import { createUseSkillTool } from "./activate.ts";
import { createRunSkillScriptTool, runnableSkills, type RunScriptOptions } from "./run-script.ts";
import { BUILTIN_HANDLERS } from "./builtins/index.ts";

export * from "./manifest.ts";
export * from "./discover.ts";
export { formatSkillCatalog } from "./catalog.ts";
export { createUseSkillTool } from "./activate.ts";
export {
  createRunSkillScriptTool,
  runnableSkills,
  DEFAULT_INTERPRETERS,
  DEFAULT_RUN_TIMEOUT_MS,
  DEFAULT_RUN_MAX_OUTPUT_BYTES,
  type RunScriptOptions,
} from "./run-script.ts";
export { BUILTIN_HANDLERS, type BuiltinFactory } from "./builtins/index.ts";

// Re-export the bundled built-in skill objects so other packages (and their
// tests) can compose them directly without depending on the deleted skills-*
// packages.
export {
  readFileSkill,
  listDirectorySkill,
  writeFileSkill,
  applyPatchSkill,
  filesystemSkills,
  MAX_WRITE_BYTES,
} from "../skills/filesystem/handler.ts";
export {
  shellSkill,
  createShellSkill,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  type ShellSkillOptions,
} from "../skills/shell/handler.ts";
export { sqlQuerySkill } from "../skills/database/handler.ts";
export { writeMemorySkill, searchMemorySkill, memorySkills } from "../skills/memory/handler.ts";
export {
  createFetchUrlSkill,
  fetchUrlSkillFromEnv,
  createWebSearchSkill,
  searchProviderFromEnv,
  webSkills,
  type FetchUrlSkillOptions,
  type WebSearchSkillOptions,
  type WebSearchProvider,
  type SearchHit,
} from "../skills/web/handler.ts";
export {
  createTodoWriteSkill,
  InMemoryTodoStore,
  formatTodos,
  type TodoItem,
  type TodoStatus,
  type TodoStore,
} from "../skills/todo/handler.ts";

/** Absolute path to the bundled built-in skills directory. */
export const BUILTIN_SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

export interface LoadAgentSkillsOptions {
  /** Directories to scan, in any order (precedence is by scope, not order). */
  dirs: SkillDir[];
  /** Defaults to process.env. Passed to built-in handler factories. */
  env?: NodeJS.ProcessEnv;
  runScript?: RunScriptOptions;
}

export interface LoadAgentSkillsResult {
  /** Every discovered skill (sorted by name). */
  skills: LoadedSkill[];
  /** Handler-backed tools to register with the agent registry. */
  tools: Skill[];
  /** Activation tool, or null when no skills were discovered. */
  useSkillTool: Skill | null;
  /** Script-execution tool, or null when no skill bundles a runnable script. */
  runScriptTool: Skill | null;
  /** The system-prompt catalog section ("" when no skills). */
  catalog: string;
  diagnostics: DiscoverDiagnostic[];
}

/**
 * Discover skills across the given directories and assemble everything the CLI
 * needs: the built-in handler tools to register, the use_skill / run_skill_script
 * tools, and the system-prompt catalog. Built-in handler code runs only for
 * trusted, bundled skills whose name is in BUILTIN_HANDLERS.
 */
export function loadAgentSkills(opts: LoadAgentSkillsOptions): LoadAgentSkillsResult {
  const env = opts.env ?? process.env;
  const { skills, diagnostics } = discoverSkills(opts.dirs);

  const tools: Skill[] = [];
  for (const s of skills) {
    if (s.scope !== "bundled" || !s.trusted) continue;
    const factory = BUILTIN_HANDLERS[s.name];
    if (factory) tools.push(...factory(env));
  }

  const useSkillTool = skills.length > 0 ? createUseSkillTool(skills) : null;
  const runnable = runnableSkills(skills, opts.runScript?.interpreters);
  const runScriptTool = runnable.length > 0 ? createRunSkillScriptTool(runnable, opts.runScript) : null;
  const catalog = formatSkillCatalog(skills);

  return { skills, tools, useSkillTool, runScriptTool, catalog, diagnostics };
}
