import { SkillRegistry } from "@miniclaw/core";
import { sqlQuerySkill } from "@miniclaw/skills-db";
import {
  applyPatchSkill,
  listDirectorySkill,
  readFileSkill,
  writeFileSkill,
} from "@miniclaw/skills-fs";
import { searchMemorySkill, writeMemorySkill } from "@miniclaw/skills-memory";
import { shellSkill } from "@miniclaw/skills-shell";
import {
  createWebSearchSkill,
  fetchUrlSkillFromEnv,
  searchProviderFromEnv,
} from "@miniclaw/skills-web";

// The single place where all built-in skills are stitched together. Adding a
// new skill = one new register() call here. Exposing this as a function (not
// inlined in main.ts) lets tests assert the wiring without booting the REPL.
//
// `env` is injected so tests can assert provider-key gating (web_search is
// only registered when MINICLAW_SEARCH_API_KEY is set; fetch_url's allowlist
// comes from MINICLAW_WEB_ALLOWLIST).
export function buildRegistry(env: NodeJS.ProcessEnv = process.env): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register(writeMemorySkill);
  registry.register(searchMemorySkill);
  registry.register(shellSkill);
  registry.register(sqlQuerySkill);
  registry.register(readFileSkill);
  registry.register(listDirectorySkill);
  registry.register(writeFileSkill);
  registry.register(applyPatchSkill);
  registry.register(fetchUrlSkillFromEnv(env));
  const searchProvider = searchProviderFromEnv(env);
  if (searchProvider) {
    registry.register(createWebSearchSkill({ provider: searchProvider }));
  }
  return registry;
}
