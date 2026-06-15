// In-process handler for the bundled `web` skill. fetch_url is always present
// (fail-closed on an empty allowlist); web_search registers only when a search
// provider key is configured. URL/redirect safety lives in
// ../../src/lib/web-allowlist.ts.
import type { Skill } from "@miniclaw/core";
import {
  createFetchUrlSkill,
  fetchUrlSkillFromEnv,
  DEFAULT_FETCH_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_REDIRECTS,
  type FetchUrlSkillOptions,
} from "./fetch-url.ts";
import {
  createWebSearchSkill,
  searchProviderFromEnv,
  DEFAULT_SEARCH_TIMEOUT_MS,
  type WebSearchSkillOptions,
  type WebSearchProvider,
  type SearchHit,
} from "./web-search.ts";

export {
  createFetchUrlSkill,
  fetchUrlSkillFromEnv,
  DEFAULT_FETCH_MAX_BYTES,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_REDIRECTS,
  type FetchUrlSkillOptions,
  createWebSearchSkill,
  searchProviderFromEnv,
  DEFAULT_SEARCH_TIMEOUT_MS,
  type WebSearchSkillOptions,
  type WebSearchProvider,
  type SearchHit,
};

/**
 * Build the web tools for the given environment. fetch_url is always returned
 * (it fails closed unless MINICLAW_WEB_ALLOWLIST is set); web_search is added
 * only when a provider key (MINICLAW_SEARCH_API_KEY) is configured.
 */
export function webSkills(env: NodeJS.ProcessEnv): Skill[] {
  const skills: Skill[] = [fetchUrlSkillFromEnv(env)];
  const provider = searchProviderFromEnv(env);
  if (provider) skills.push(createWebSearchSkill({ provider }));
  return skills;
}
