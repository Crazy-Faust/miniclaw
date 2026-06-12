import {
  currentLLMUsageContext,
  type AssistantTurn,
  type LLMProvider,
  type LLMUsageSink,
  type Message,
  type ToolSpec,
} from "@miniclaw/core";
import type { ProviderId } from "./config.ts";

export interface TrackLLMUsageOpts {
  provider: ProviderId;
  model: string;
  role: "primary" | "small";
}

export function trackLLMUsage(
  llm: LLMProvider,
  sink: LLMUsageSink | undefined,
  opts: TrackLLMUsageOpts,
): LLMProvider {
  if (!sink) return llm;
  return {
    async chat(args: {
      system: string;
      messages: Message[];
      tools: ToolSpec[];
      onToken?: (delta: string) => void;
    }): Promise<AssistantTurn> {
      try {
        const turn = await llm.chat(args);
        const context = currentLLMUsageContext();
        sink.recordLLMUsage({
          provider: opts.provider,
          model: opts.model,
          role: opts.role,
          kind: turn.kind,
          ...(context ? { context } : {}),
          usage: turn.usage,
        });
        return turn;
      } catch (err) {
        const context = currentLLMUsageContext();
        sink.recordLLMUsage({
          provider: opts.provider,
          model: opts.model,
          role: opts.role,
          kind: "error",
          ...(context ? { context } : {}),
        });
        throw err;
      }
    },
  };
}
