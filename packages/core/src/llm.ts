import { AsyncLocalStorage } from "node:async_hooks";

// LLM provider contract. Implementations live in their own package
// (e.g. @miniclaw/llm-anthropic) and import only from here.

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResultPart {
  toolCallId: string;
  /** Name of the tool that was called. Required by name-keyed APIs (Gemini); ignored by id-keyed APIs (Anthropic, OpenAI). */
  toolName: string;
  content: string;
  isError: boolean;
}

export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; results: ToolResultPart[] };

/**
 * Token usage for a single LLM call. Providers fill in whatever they
 * report; consumers should treat each field as optional.
 */
export interface LLMUsage {
  /** Tokens consumed by the input (system + messages + tools). */
  inputTokens?: number;
  /** Tokens produced by the assistant for this turn. */
  outputTokens?: number;
  /** Tokens served from a provider-side prompt cache, if reported. */
  cacheReadTokens?: number;
  /** Tokens written to a provider-side prompt cache, if reported. */
  cacheWriteTokens?: number;
}

export interface LLMUsageRecord {
  provider: string;
  model: string;
  /** Logical role in miniclaw, e.g. primary or small. */
  role: string;
  /** Result kind for the call, e.g. final, tool_use, or error. */
  kind: string;
  context?: LLMUsageContext;
  usage?: LLMUsage;
  ts?: number;
}

export interface LLMUsageContext {
  /** User-facing purpose bucket, e.g. user_message, cron, compaction. */
  taskKind?: string;
  /** Optional task label, e.g. cron #12 or security gate shell. */
  taskName?: string;
  /** Transport/session channel, e.g. cli, discord:dm:..., cron:12:... */
  channel?: string;
  sessionId?: string;
  conversationId?: number;
  /** Internal component responsible for the call. */
  component?: string;
}

export type AssistantTurn =
  | { kind: "final"; text: string; usage?: LLMUsage }
  | { kind: "tool_use"; text: string; toolCalls: ToolCall[]; usage?: LLMUsage };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LLMProvider {
  chat(opts: {
    system: string;
    messages: Message[];
    tools: ToolSpec[];
    /**
     * Optional incremental-text sink. Providers that stream call this once
     * per token (or chunk) as the response arrives. Providers without
     * streaming support simply ignore the callback. The agent forwards
     * AgentTurnHooks.onAssistantToken here so harnesses can flush deltas.
     */
    onToken?: (delta: string) => void;
  }): Promise<AssistantTurn>;
}

export interface LLMUsageSink {
  recordLLMUsage(record: LLMUsageRecord): void;
}

const llmUsageContextStorage = new AsyncLocalStorage<LLMUsageContext>();

export function currentLLMUsageContext(): LLMUsageContext | undefined {
  return llmUsageContextStorage.getStore();
}

export function withLLMUsageContext<T>(
  context: LLMUsageContext,
  fn: () => T,
): T {
  const merged: LLMUsageContext = { ...(currentLLMUsageContext() ?? {}) };
  for (const [key, value] of Object.entries(context) as Array<
    [keyof LLMUsageContext, LLMUsageContext[keyof LLMUsageContext]]
  >) {
    if (value !== undefined) {
      (merged as Record<keyof LLMUsageContext, unknown>)[key] = value;
    }
  }
  return llmUsageContextStorage.run(merged, fn);
}
