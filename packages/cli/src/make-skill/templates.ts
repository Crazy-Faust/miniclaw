// Templates for the agentskills.io SKILL.md scaffolder. A scaffolded skill is
// a folder with a SKILL.md (metadata + instructions) and, optionally, a bundled
// script under scripts/ that the agent runs with run_skill_script.

export type ScriptLanguage = "python" | "node" | "bash";

export interface SkillScriptSpec {
  language: ScriptLanguage;
  /** File name within scripts/, e.g. "run.py". */
  fileName: string;
}

export interface SkillSpec {
  /** kebab-case skill name; also the folder name and the SKILL.md `name`. */
  name: string;
  /** One-line description for the frontmatter (what it does + when to use it). */
  description: string;
  /** Optional bundled script. */
  script?: SkillScriptSpec;
}

const EXT_BY_LANGUAGE: Record<ScriptLanguage, string> = {
  python: ".py",
  node: ".mjs",
  bash: ".sh",
};

export function defaultScriptFileName(language: ScriptLanguage): string {
  return `run${EXT_BY_LANGUAGE[language]}`;
}

export function skillMdContent(spec: SkillSpec): string {
  const scriptSection = spec.script
    ? `\n## Scripts\n\n` +
      `Run the bundled script with the \`run_skill_script\` tool:\n\n` +
      "```\n" +
      `run_skill_script(skill="${spec.name}", script="scripts/${spec.script.fileName}")\n` +
      "```\n"
    : "";

  return `---
name: ${spec.name}
description: ${spec.description}
---

# ${titleCase(spec.name)}

<!-- Describe what this skill does and, step by step, how to do the task.
     Keep this file focused; move long reference material into references/. -->

## When to use

Use this skill when ...

## Steps

1. ...
2. ...
${scriptSection}`;
}

export function scriptStubContent(language: ScriptLanguage): string {
  if (language === "python") {
    return [
      "#!/usr/bin/env python3",
      '"""Bundled skill script. Reads argv and prints a result."""',
      "import sys",
      "",
      "",
      "def main(argv: list[str]) -> int:",
      '    print("hello from skill script", *argv)',
      "    return 0",
      "",
      "",
      'if __name__ == "__main__":',
      "    raise SystemExit(main(sys.argv[1:]))",
      "",
    ].join("\n");
  }
  if (language === "node") {
    return [
      "#!/usr/bin/env node",
      "// Bundled skill script. Reads argv and prints a result.",
      "const args = process.argv.slice(2);",
      'console.log("hello from skill script", ...args);',
      "",
    ].join("\n");
  }
  return [
    "#!/usr/bin/env bash",
    "# Bundled skill script. Reads argv and prints a result.",
    "set -euo pipefail",
    'echo "hello from skill script $*"',
    "",
  ].join("\n");
}

// ---- Helpers ----

export function titleCase(kebab: string): string {
  return kebab
    .split("-")
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join(" ");
}
