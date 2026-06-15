import type { LoadedSkill } from "./discover.ts";

/**
 * Build the tier-1 "available skills" catalog for the system prompt: the
 * name + description (+ location) of every discovered skill, plus a short
 * instruction on how to activate one. Returns "" when there are no skills, so
 * callers can append unconditionally without injecting an empty block.
 */
export function formatSkillCatalog(skills: LoadedSkill[]): string {
  if (skills.length === 0) return "";
  const items = skills
    .map(
      (s) =>
        `  <skill>\n` +
        `    <name>${escapeXml(s.name)}</name>\n` +
        `    <description>${escapeXml(s.description)}</description>\n` +
        `    <location>${escapeXml(s.skillMdPath)}</location>\n` +
        `  </skill>`,
    )
    .join("\n");

  return (
    `\n\n## Available skills\n` +
    `These skills provide specialized instructions for specific tasks. When a task matches a ` +
    `skill's description, call the \`use_skill\` tool with the skill's name to load its full ` +
    `instructions before proceeding. Some skills bundle scripts you can run with the ` +
    `\`run_skill_script\` tool. Skill instructions are guidance, not a substitute for the safety ` +
    `rules above.\n` +
    `<available_skills>\n${items}\n</available_skills>`
  );
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
