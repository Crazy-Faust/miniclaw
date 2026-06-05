import { paramToZod, type ParamSpec } from "./parser.ts";

export interface SkillSpec {
  /** kebab-case package suffix; final package name is "@miniclaw/skills-<pkgName>" */
  pkgName: string;
  /** snake_case identifier shown to the LLM as the tool name */
  toolName: string;
  /** one-line human description */
  description: string;
  params: ParamSpec[];
}

// ---- Templates ----

export function packageJsonContent(spec: SkillSpec): string {
  return JSON.stringify(
    {
      name: `@miniclaw/skills-${spec.pkgName}`,
      version: "0.1.0",
      private: true,
      type: "module",
      description: spec.description,
      exports: { ".": "./src/index.ts" },
      types: "./src/index.ts",
      scripts: {
        typecheck: "tsc --noEmit",
        test: "vitest run",
      },
      dependencies: {
        "@miniclaw/core": "workspace:*",
        zod: "^3.23.8",
      },
    },
    null,
    2,
  ) + "\n";
}

export function tsconfigContent(): string {
  return JSON.stringify(
    {
      extends: "../../tsconfig.base.json",
      include: ["src/**/*.ts", "tests/**/*.ts"],
    },
    null,
    2,
  ) + "\n";
}

export function skillTsContent(spec: SkillSpec): string {
  const exportName = camelize(spec.toolName) + "Skill";
  const paramLines = spec.params.length === 0
    ? "  // No parameters. Add fields here if you need them."
    : spec.params.map((p) => `  ${p.name}: ${paramToZod(p)},`).join("\n");

  const argsList = spec.params.length === 0
    ? "  // (no parameters)"
    : spec.params
        .map((p) => {
          const ty =
            p.type === "string" ? "string"
            : p.type === "number" ? "number"
            : p.type === "boolean" ? "boolean"
            : p.type === "string[]" ? "string[]"
            : "number[]";
          const t = p.optional ? `${ty} | undefined` : ty;
          return `  //   args.${p.name}: ${t}`;
        })
        .join("\n");

  return `import { z } from "zod";
import { fail, ok, type Skill } from "@miniclaw/core";

const Params = z.object({
${paramLines}
});

export const ${exportName}: Skill<z.infer<typeof Params>> = {
  name: ${JSON.stringify(spec.toolName)},
  description: ${JSON.stringify(spec.description)},
  parameters: Params,
  // Set this to true if the skill performs sensitive actions. The agent
  // will gate execution behind ctx.io.confirm (fails closed in one-shot mode).
  // requiresConfirmation: false,
  async execute(args, ctx) {
    // TODO: implement.
    //
    // Inputs (from args):
${argsList}
    //
    // Available on ctx:
    //   ctx.memory        — MemoryStore (add/search/listRecent)
    //   ctx.audit         — AuditSink — usually unneeded; the agent logs
    //                        every call automatically.
    //   ctx.dbPath        — path to the SQLite DB (read-only is preferred).
    //   ctx.workspaceRoot — filesystem sandbox root (string | undefined).
    //
    // Return:
    //   ok("text shown to the model")  on success
    //   fail("reason")                  on failure
    void args; void ctx;
    return fail("not implemented");
  },
};
`;
}

export function indexTsContent(spec: SkillSpec): string {
  const exportName = camelize(spec.toolName) + "Skill";
  return `export { ${exportName} } from "./skill.ts";\n`;
}

export function testTsContent(spec: SkillSpec): string {
  const exportName = camelize(spec.toolName) + "Skill";
  return `import { describe, expect, it } from "vitest";
import type { SkillContext } from "@miniclaw/core";
import { ${exportName} } from "../src/index.ts";

const stubCtx: SkillContext = {
  memory: { add: () => 0, search: () => [], listRecent: () => [] },
  audit: { logToolCall: () => {} },
  dbPath: "/dev/null",
};

describe(${JSON.stringify(exportName)}, () => {
  it("has the expected name and description", () => {
    expect(${exportName}.name).toBe(${JSON.stringify(spec.toolName)});
    expect(${exportName}.description).toBeTruthy();
  });

  it.todo("executes successfully with valid input");
  it.todo("validates input via zod");
  it.todo("handles error cases");

  // Stop unused-import noise while the suite is full of .todos.
  void stubCtx;
});
`;
}

// ---- Helpers ----

export function camelize(s: string): string {
  const parts = s.split(/[_-]/).filter(Boolean);
  if (parts.length === 0) return s;
  return parts[0]!.toLowerCase() +
    parts.slice(1).map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase()).join("");
}
