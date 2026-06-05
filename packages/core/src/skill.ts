import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolSpec } from "./llm.ts";
import type { AuditSink } from "./audit.ts";
import type { MemoryStore } from "./memory.ts";

// What every skill receives when invoked. Pass things in here, never reach
// out to globals — that's what keeps skills swappable.
export interface SkillContext {
  memory: MemoryStore;
  audit: AuditSink;
  dbPath: string;
  /**
   * Optional filesystem sandbox root. Skills that touch the filesystem
   * (skills-fs, optionally skills-shell) refuse to operate on paths that
   * don't resolve under this directory. Unset = no sandbox (legacy behavior).
   */
  workspaceRoot?: string;
  /**
   * Optional incremental-output sink. Skills with long-running output
   * (notably skills-shell) call this as bytes arrive so a UI can show
   * progress before the skill returns. The chunk passed is exactly what
   * the underlying process produced; the receiver decides how to render
   * it (line buffering, ANSI handling, etc.).
   */
  onStream?: (kind: "stdout" | "stderr", chunk: string) => void;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

// Note: input is `unknown` (not A) so zod schemas with `.default()` —
// which have different input vs output types — still fit. The agent calls
// `parameters.safeParse(...)` and only the output type matters downstream.
export interface Skill<A = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<A, z.ZodTypeDef, unknown>;
  requiresConfirmation?: boolean;
  execute(args: A, ctx: SkillContext): Promise<ToolResult> | ToolResult;
}

export function ok(output: string): ToolResult {
  return { ok: true, output };
}

export function fail(output: string): ToolResult {
  return { ok: false, output };
}

export function toolSpecFromSkill(skill: Skill<unknown>): ToolSpec {
  const json = zodToJsonSchema(skill.parameters, { target: "jsonSchema7" }) as Record<string, unknown>;
  delete (json as { $schema?: unknown }).$schema;
  return {
    name: skill.name,
    description: skill.description,
    inputSchema: json,
  };
}
