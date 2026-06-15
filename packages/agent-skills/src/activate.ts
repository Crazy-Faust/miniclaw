import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { fail, ok, type Skill } from "@miniclaw/core";
import { parseSkillMd } from "./manifest.ts";
import type { LoadedSkill } from "./discover.ts";

// In-process handler entry points are not runnable "resources" — don't surface
// them to the model as files to read or run.
const RESERVED = new Set(["handler.ts", "handler.js", "handler.mjs"]);
const RESOURCE_DIRS = ["scripts", "references", "assets"];
const MAX_RESOURCES = 50;

/**
 * Build the `use_skill` activation tool (tier 2 of progressive disclosure). It
 * returns the full SKILL.md body wrapped in <skill_content>, plus the skill
 * directory and a capped listing of bundled resources. The `name` parameter is
 * constrained to the known skill names so the model can't invent one.
 */
export function createUseSkillTool(skills: LoadedSkill[]): Skill {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const names = skills.map((s) => s.name);
  const nameSchema =
    names.length > 0
      ? z.enum(names as [string, ...string[]])
      : z.string();

  const Params = z.object({
    name: nameSchema.describe("The name of the skill to activate (from the available_skills catalog)."),
  });

  const tool: Skill<z.infer<typeof Params>> = {
    name: "use_skill",
    description:
      "Load the full instructions for an available skill by name. Returns the skill's SKILL.md " +
      "body and a listing of its bundled resources. Call this when a task matches a skill in the " +
      "available_skills catalog, before doing the work.",
    parameters: Params,
    execute(args) {
      const s = byName.get(args.name);
      if (!s) return fail(`unknown skill: ${args.name}`);

      // Read fresh from disk so edits to SKILL.md are picked up between turns;
      // fall back to the body captured at discovery time.
      let body = s.body;
      try {
        const parsed = parseSkillMd(readFileSync(s.skillMdPath, "utf8"));
        if (!("error" in parsed)) body = parsed.body;
      } catch {
        // keep the cached body
      }

      const resources = listResources(s.dir);
      const resourceBlock =
        resources.length > 0
          ? `\n\n<skill_resources>\n${resources.map((r) => `  <file>${r}</file>`).join("\n")}\n</skill_resources>`
          : "";

      return ok(
        `<skill_content name="${s.name}">\n${body}\n\n` +
          `Skill directory: ${s.dir}\n` +
          `Relative paths in this skill resolve against the skill directory. ` +
          `Run bundled scripts with the run_skill_script tool (skill="${s.name}").` +
          `${resourceBlock}\n</skill_content>`,
      );
    },
  };
  return tool;
}

function listResources(dir: string): string[] {
  const out: string[] = [];
  for (const sub of RESOURCE_DIRS) {
    const root = join(dir, sub);
    if (!existsSync(root)) continue;
    walk(root, dir, out);
  }
  return out.slice(0, MAX_RESOURCES);
}

function walk(current: string, skillRoot: string, out: string[]): void {
  if (out.length >= MAX_RESOURCES) return;
  let entries: string[];
  try {
    entries = readdirSync(current);
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_RESOURCES) return;
    const p = join(current, e);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      walk(p, skillRoot, out);
    } else if (!RESERVED.has(e)) {
      out.push(relative(skillRoot, p));
    }
  }
}
