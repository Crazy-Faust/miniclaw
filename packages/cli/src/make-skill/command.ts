import type { MetaCommand, MetaCommandContext } from "@miniclaw/harness";
import { createSkillFolder, defaultSkillsDir } from "./files.ts";
import { defaultScriptFileName, type ScriptLanguage, type SkillSpec } from "./templates.ts";

export interface MakeSkillOpts {
  /** Where to scaffold. Defaults to `<workspace>/skills`. Tests override this. */
  skillsDir?: string;
  /** Override the file writes. Used by tests; defaults to real writes. */
  effects?: {
    create: typeof createSkillFolder;
  };
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LANGUAGES: ReadonlySet<string> = new Set(["python", "node", "bash"]);

// Interactive scaffolder for agentskills.io SKILL.md folders. Walks the user
// through a name, description, and an optional bundled script, then writes
// `<skillsDir>/<name>/`. Skills are discovered at startup — there is nothing to
// register.
export function makeSkillCommand(opts: MakeSkillOpts = {}): MetaCommand {
  const skillsDir = opts.skillsDir ?? defaultSkillsDir();
  const create = opts.effects?.create ?? createSkillFolder;

  return {
    name: "/make_skill",
    description: "Scaffold a new agentskills.io SKILL.md skill folder.",
    matches: (line) => line === "/make_skill",
    async run(_line, ctx) {
      const spec = await prompt(ctx);
      if (!spec) return; // user cancelled

      try {
        const created = create(spec, skillsDir);
        ctx.io.write(
          `\nCreated ${created.skillDir} with:\n` +
            created.files.map((f) => `  ${f}\n`).join("") +
            `\nThe skill is discovered automatically next time miniclaw starts ` +
            `(it scans <workspace>/skills and $MINICLAW_HOME/skills).\n` +
            (spec.script
              ? `Run its script with run_skill_script(skill="${spec.name}", script="scripts/${spec.script.fileName}").\n`
              : "") +
            `Open ${spec.name}/SKILL.md and write the instructions.\n\n`,
        );
      } catch (err) {
        ctx.io.write(`\nrefused: ${(err as Error).message}\n\n`);
      }
    },
  };
}

async function prompt(ctx: MetaCommandContext): Promise<SkillSpec | null> {
  ctx.io.write(
    "Scaffolding a new SKILL.md skill. Press Ctrl-D / EOF at any prompt to cancel.\n",
  );

  const name = await ask(ctx, "Skill name (kebab-case, e.g. pdf-tools): ", (v) =>
    NAME_RE.test(v) ? null : "must be lowercase kebab-case (letters, digits, single hyphens)",
  );
  if (name === null) return null;

  const description = await ask(
    ctx,
    "One-line description (what it does + when to use it): ",
    (v) => (v.length === 0 ? "must be non-empty" : null),
  );
  if (description === null) return null;

  const langRaw = await ask(
    ctx,
    "Bundle a script? (none/python/node/bash) [none]: ",
    (v) => {
      const lower = v.toLowerCase();
      return lower === "" || lower === "none" || LANGUAGES.has(lower)
        ? null
        : "choose none, python, node, or bash";
    },
    /* allowEmpty */ true,
  );
  if (langRaw === null) return null;

  const lang = langRaw.toLowerCase();
  let script: SkillSpec["script"];
  if (LANGUAGES.has(lang)) {
    const language = lang as ScriptLanguage;
    const def = defaultScriptFileName(language);
    const fileName = await ask(ctx, `Script file name [${def}]: `, () => null, true);
    if (fileName === null) return null;
    script = { language, fileName: fileName === "" ? def : fileName };
  }

  return { name, description, script };
}

async function ask(
  ctx: MetaCommandContext,
  prompt: string,
  validate: (v: string) => string | null,
  allowEmpty = false,
): Promise<string | null> {
  // Re-prompt on validation failure, up to 5 attempts.
  for (let i = 0; i < 5; i++) {
    const raw = await ctx.io.readLine(prompt);
    if (raw === null) return null; // EOF = cancel
    const v = raw.trim();
    if (v === "" && !allowEmpty) {
      ctx.io.write("  (cancelled — blank input not allowed here)\n");
      return null;
    }
    const err = validate(v);
    if (err === null) return v;
    ctx.io.write(`  error: ${err}\n`);
  }
  ctx.io.write("  (cancelled — too many invalid attempts)\n");
  return null;
}
