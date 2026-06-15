// The explicit in-process trust boundary: bundled skills whose logic runs as
// first-party handler code, keyed by their SKILL.md `name`. Each factory takes
// the process env (so a skill can self-gate on configuration) and returns the
// tools to register — an empty array means "not available in this environment".
//
// Adding a built-in: drop a folder under ../../skills/<name>/ (SKILL.md +
// scripts/handler.ts) and add one line here. Discovery handles the catalog,
// activation, and resource listing automatically.
import type { Skill } from "@miniclaw/core";
import { filesystemSkills } from "../../skills/filesystem/handler.ts";
import { shellSkill } from "../../skills/shell/handler.ts";
import { sqlQuerySkill } from "../../skills/database/handler.ts";
import { memorySkills } from "../../skills/memory/handler.ts";
import { webSkills } from "../../skills/web/handler.ts";
import { canvasSkills } from "../../skills/canvas/handler.ts";
import { todoSkills } from "../../skills/todo/handler.ts";
import { browserSkills } from "../../skills/browser/handler.ts";

export type BuiltinFactory = (env: NodeJS.ProcessEnv) => Skill[];

export const BUILTIN_HANDLERS: Record<string, BuiltinFactory> = {
  filesystem: () => filesystemSkills,
  shell: () => [shellSkill],
  database: () => [sqlQuerySkill],
  memory: () => memorySkills,
  web: (env) => webSkills(env),
  canvas: () => canvasSkills(),
  todo: () => todoSkills(),
  // Only registers tools when the optional `playwright` peer is installed.
  browser: (env) => browserSkills(env),
};
