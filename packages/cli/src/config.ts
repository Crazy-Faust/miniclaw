import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export type ProviderId = "anthropic" | "openai" | "gemini";

export interface Config {
  home: string;
  dbPath: string;
  provider: ProviderId;
  apiKey: string;
  model: string;
  /** Only relevant for the openai provider; lets you point at Ollama, LM Studio, etc. */
  baseURL?: string;
  /** Filesystem sandbox root for skills-fs / skills-shell. Defaults to process.cwd(). */
  workspaceRoot: string;
}

const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o-mini",
  gemini: "gemini-3.1-flash-lite",
};

const API_KEY_VARS: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export function loadConfig(): Config {
  const home = process.env.MINICLAW_HOME ?? join(homedir(), ".miniclaw");
  mkdirSync(home, { recursive: true });

  const rawProvider = (process.env.MINICLAW_PROVIDER ?? "anthropic").toLowerCase();
  if (rawProvider !== "anthropic" && rawProvider !== "openai" && rawProvider !== "gemini") {
    throw new Error(
      `MINICLAW_PROVIDER must be one of: anthropic, openai, gemini. Got: ${rawProvider}`,
    );
  }
  const provider = rawProvider as ProviderId;

  const apiKeyVar = API_KEY_VARS[provider];
  const apiKey = process.env[apiKeyVar] ?? "";
  if (!apiKey) {
    throw new Error(
      `${apiKeyVar} is not set. Copy .env.example to .env and fill it in (or change MINICLAW_PROVIDER).`,
    );
  }

  const workspaceRoot = resolve(process.env.MINICLAW_WORKSPACE ?? process.cwd());

  return {
    home,
    dbPath: join(home, "miniclaw.db"),
    provider,
    apiKey,
    model: process.env.MINICLAW_MODEL ?? DEFAULT_MODELS[provider],
    baseURL: process.env.MINICLAW_BASE_URL,
    workspaceRoot,
  };
}
