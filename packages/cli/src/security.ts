import { createLLMToolSecurityGuard, type ToolGuard } from "@miniclaw/agent";
import type { LLMProvider } from "@miniclaw/core";
import type { Config } from "./config.ts";

export function buildToolGuard(config: Config, smallLLM: LLMProvider | undefined): ToolGuard | undefined {
  if (config.securityMode !== "high") return undefined;
  if (!smallLLM) {
    throw new Error(
      "MINICLAW_SECURITY_MODE=high requires MINICLAW_SMALL_PROVIDER to be configured.",
    );
  }
  return createLLMToolSecurityGuard(smallLLM);
}

export function describeSecurityMode(config: Config): string {
  if (config.securityMode === "high") return "high (small-LLM tool gate)";
  if (config.securityMode === "medium") return "medium";
  return "off";
}
