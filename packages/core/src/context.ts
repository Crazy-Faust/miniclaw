import type { Message } from "./llm.ts";

// Build the per-turn prompt, and record the resulting turn. Implementations
// decide retrieval strategy (FTS, vector, none), window size, etc.

export interface ContextManager {
  prepare(userMsg: string): { system: string; messages: Message[] };
  recordUser(content: string): void;
  recordAssistant(content: string, toolCallsJson?: string | null): void;
}
