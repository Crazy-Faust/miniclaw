import type { MetaCommand, MetaCommandContext } from "@miniclaw/harness";
import {
  createSkillPackage,
  defaultRepoRoot,
  patchCliPackageJson,
  patchCliSkills,
} from "./files.ts";
import { parseParamSpec } from "./parser.ts";
import type { SkillSpec } from "./templates.ts";

export interface MakeSkillOpts {
  /** Override the repo root for tests. Default: walks up from cli to find pnpm-workspace.yaml. */
  repoRoot?: string;
  /** Override the actual file writes. Used by tests; defaults to real writes. */
  effects?: {
    create: typeof createSkillPackage;
    patchSkills: typeof patchCliSkills;
    patchPackageJson: typeof patchCliPackageJson;
  };
}

const PKG_NAME_RE = /^[a-z][a-z0-9-]*$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

// Interactive scaffolder: walks the user through choosing a name, tool name,
// description, and parameter spec, then writes a new packages/skills-<name>/
// and registers it in cli/src/skills.ts + cli/package.json. The whole flow
// is `await`-driven on ctx.io.readLine so it works inside the harness loop.
export function makeSkillCommand(opts: MakeSkillOpts = {}): MetaCommand {
  const repoRoot = opts.repoRoot ?? defaultRepoRoot();
  const effects = opts.effects ?? {
    create: createSkillPackage,
    patchSkills: patchCliSkills,
    patchPackageJson: patchCliPackageJson,
  };

  return {
    name: "/make_skill",
    description: "Scaffold a new skill package and register it with the CLI.",
    matches: (line) => line === "/make_skill",
    async run(_line, ctx) {
      const spec = await prompt(ctx);
      if (!spec) return; // user cancelled

      try {
        const created = effects.create(spec, repoRoot);
        const skillsPatch = effects.patchSkills(spec, repoRoot);
        const pkgPatch = effects.patchPackageJson(spec, repoRoot);

        ctx.io.write(
          `\nCreated ${created.packageDir} with:\n` +
            created.files.map((f) => `  ${f}\n`).join("") +
            `\nRegistration: skills.ts ${skillsPatch.changed ? "updated" : "(unchanged)"}, ` +
            `cli/package.json ${pkgPatch.changed ? "updated" : "(unchanged)"}\n` +
            `\nNext steps:\n` +
            `  1. pnpm install            # link the new workspace package\n` +
            `  2. open packages/skills-${spec.pkgName}/src/skill.ts and implement execute()\n` +
            `  3. pnpm typecheck && pnpm test\n\n`,
        );
      } catch (err) {
        ctx.io.write(`\nrefused: ${(err as Error).message}\n\n`);
      }
    },
  };
}

async function prompt(ctx: MetaCommandContext): Promise<SkillSpec | null> {
  ctx.io.write(
    "Scaffolding a new skill. Press Ctrl-D / EOF at any prompt to cancel.\n",
  );

  const pkgName = await ask(ctx, "Skill package name (kebab-case, e.g. fetch-url): ", (v) => {
    if (!PKG_NAME_RE.test(v)) return "must be lowercase kebab-case (e.g. fetch-url)";
    return null;
  });
  if (pkgName === null) return null;

  const toolName = await ask(
    ctx,
    `Tool name shown to the LLM (snake_case, e.g. fetch_url) [${suggestToolName(pkgName)}]: `,
    (v) => (v === "" ? null : TOOL_NAME_RE.test(v) ? null : "must be lowercase snake_case"),
    /* allowEmpty (use the suggestion) */ true,
  );
  if (toolName === null) return null;
  const effectiveToolName = toolName === "" ? suggestToolName(pkgName) : toolName;

  const description = await ask(ctx, "One-line description: ", (v) =>
    v.length === 0 ? "must be non-empty" : null,
  );
  if (description === null) return null;

  const paramSpec = await ask(
    ctx,
    "Parameters (e.g. 'url:string, timeout:number?'; blank for none): ",
    (v) => {
      try { parseParamSpec(v); return null; }
      catch (err) { return (err as Error).message; }
    },
    /* allowEmpty */ true,
  );
  if (paramSpec === null) return null;

  const params = parseParamSpec(paramSpec);

  return {
    pkgName,
    toolName: effectiveToolName,
    description,
    params,
  };
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

function suggestToolName(pkgName: string): string {
  return pkgName.replace(/-/g, "_");
}
