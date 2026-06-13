import type { LLMProvider } from "@miniclaw/core";
import { AnthropicProvider } from "@miniclaw/llm-anthropic";
import { GeminiProvider } from "@miniclaw/llm-gemini";
import { OpenAIProvider } from "@miniclaw/llm-openai";
import type { Config, LLMConfig } from "./config.ts";

// The only place in the whole codebase that maps a provider id to a concrete
// LLMProvider constructor. Adding a new provider = adding one case here.
export function buildLLM(config: Config): LLMProvider {
  return buildLLMFromConfig(config);
}

export function buildSmallLLM(config: Config): LLMProvider | undefined {
  return config.smallLLM ? buildLLMFromConfig(config.smallLLM) : undefined;
}

function buildLLMFromConfig(config: LLMConfig): LLMProvider {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicProvider({ apiKey: config.apiKey, model: config.model });
    case "openai":
      return new OpenAIProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseURL: config.baseURL,
      });
    case "gemini":
      return new GeminiProvider({ apiKey: config.apiKey, model: config.model });
  }
}
