export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: number;
  content: string;
  status: TodoStatus;
  createdAt: number;
  updatedAt: number;
}

export interface TodoStore {
  list(): TodoItem[];
  /**
   * Replace the entire plan with the new list (TodoWrite semantics — the
   * model owns the plan and rewrites it each turn). Items without an id
   * are appended; items with a known id retain their createdAt timestamp.
   */
  replace(items: Array<{ id?: number; content: string; status: TodoStatus }>): TodoItem[];
  clear(): void;
}

/**
 * In-memory TodoStore — one per process. Persisting the plan across
 * restarts is a deliberate non-feature: TodoWrite is meant for plans the
 * model is working on RIGHT NOW; long-term goals belong in MemoryStore.
 */
export class InMemoryTodoStore implements TodoStore {
  private items: TodoItem[] = [];
  private nextId = 1;

  list(): TodoItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  replace(input: Array<{ id?: number; content: string; status: TodoStatus }>): TodoItem[] {
    const now = Date.now();
    const byId = new Map(this.items.map((i) => [i.id, i]));
    const next: TodoItem[] = [];
    for (const incoming of input) {
      if (incoming.id !== undefined && byId.has(incoming.id)) {
        const prev = byId.get(incoming.id)!;
        const same = prev.content === incoming.content && prev.status === incoming.status;
        next.push({
          id: prev.id,
          content: incoming.content,
          status: incoming.status,
          createdAt: prev.createdAt,
          updatedAt: same ? prev.updatedAt : now,
        });
      } else {
        next.push({
          id: this.nextId++,
          content: incoming.content,
          status: incoming.status,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    this.items = next;
    return this.list();
  }

  clear(): void {
    this.items = [];
  }
}

/** Render the plan as plain text. */
export function formatTodos(items: TodoItem[]): string {
  if (items.length === 0) return "  (no plan yet — the model can call todo_write)\n";
  const symbol = (s: TodoStatus): string => (s === "completed" ? "[x]" : s === "in_progress" ? "[~]" : "[ ]");
  return items.map((i) => `  ${symbol(i.status)} #${i.id} ${i.content}`).join("\n") + "\n";
}
