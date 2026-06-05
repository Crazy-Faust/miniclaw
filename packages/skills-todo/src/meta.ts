import { formatTodos, type TodoStore } from "./store.ts";

// Structural MetaCommand type — duplicated here to avoid an upward
// dependency on @miniclaw/harness from a skills package. The shape
// matches harness/src/meta.ts byte-for-byte; if it ever drifts the
// CLI wiring will fail at compile time.
interface MetaCmd {
  name: string;
  description: string;
  matches(line: string): boolean;
  run(line: string, ctx: { io: { write(text: string): void } }): void | Promise<void>;
}

/**
 * /todos meta-command — view the plan the model has been maintaining via
 * todo_write. `/todos clear` resets the plan.
 */
export function createTodosCommand(store: TodoStore): MetaCmd {
  return {
    name: "/todos",
    description: "Show the model's current plan. /todos clear resets it.",
    matches: (line) => line === "/todos" || line === "/todos clear",
    run(line, ctx) {
      if (line === "/todos clear") {
        store.clear();
        ctx.io.write("  (plan cleared)\n");
        return;
      }
      ctx.io.write(formatTodos(store.list()));
    },
  };
}
