import { z } from "zod";
import { ok, type Skill } from "@miniclaw/core";
import type { TodoStore } from "./store.ts";

const StatusEnum = z.enum(["pending", "in_progress", "completed"]);

const TodoWriteParams = z.object({
  items: z
    .array(
      z.object({
        id: z.number().int().positive().optional(),
        content: z
          .string()
          .min(1)
          .max(500)
          .describe("One concrete step in the plan. Keep it short and actionable."),
        status: StatusEnum.describe("pending | in_progress | completed"),
      }),
    )
    .max(50)
    .describe(
      "The COMPLETE new plan. Each call replaces the previous list — include unchanged items too.",
    ),
});

/**
 * Bind the skill to a specific TodoStore. The CLI wiring creates one
 * store per session and passes it to both this factory and the /todos
 * meta-command so they share state.
 */
export function createTodoWriteSkill(store: TodoStore): Skill<z.infer<typeof TodoWriteParams>> {
  return {
    name: "todo_write",
    description:
      "Maintain a multi-step plan that persists across turns of this session. " +
      "Call this whenever you need to track multiple steps you're working through. " +
      "Each call REPLACES the entire plan — include items you haven't changed too. " +
      "Use status='pending' (not started), 'in_progress' (currently working on this — keep it to ONE item), or 'completed'.",
    parameters: TodoWriteParams,
    async execute(args) {
      const updated = store.replace(args.items);
      return ok(
        `plan updated; ${updated.length} item${updated.length === 1 ? "" : "s"} total\n` +
          `<tool_output>\n${JSON.stringify(updated, null, 2)}\n</tool_output>`,
      );
    },
  };
}
