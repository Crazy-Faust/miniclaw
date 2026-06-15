// Minimal, dependency-free SKILL.md parser + validator following the
// agentskills.io specification (https://agentskills.io/specification). We parse
// only the field shapes the spec defines (scalars + a flat `metadata` map),
// and validate leniently per the client-implementation guide: warn on cosmetic
// issues but still load; skip only when a description is missing or the
// frontmatter is unparseable.

export interface SkillManifest {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  /** The spec's `allowed-tools` field (space-separated tool list). */
  allowedTools?: string;
}

export interface Diagnostic {
  level: "warn" | "error";
  message: string;
}

export type Frontmatter = Record<string, string | Record<string, string>>;

export interface ParsedSkillMd {
  frontmatter: Frontmatter;
  body: string;
}

// Required: 1-64 chars, lowercase alphanumeric + single hyphens, no leading /
// trailing / consecutive hyphens.
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Split a SKILL.md file into its YAML frontmatter and markdown body. Returns
 * an `{ error }` object when the leading `---` frontmatter block is absent.
 */
export function parseSkillMd(raw: string): ParsedSkillMd | { error: string } {
  const text = raw.replace(/^﻿/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!m) {
    return { error: "missing YAML frontmatter (expected a leading '---' block)" };
  }
  const frontmatter = parseFrontmatterBlock(m[1] ?? "");
  const body = (m[2] ?? "").trim();
  return { frontmatter, body };
}

/**
 * Validate a parsed frontmatter against the spec. `dirName` is the skill's
 * parent directory name (used for the name-match check, and as a fallback when
 * `name` is absent). Returns `manifest: undefined` when the skill must be
 * skipped (an `error`-level diagnostic is present).
 */
export function validateManifest(
  fm: Frontmatter,
  dirName?: string,
): { manifest?: SkillManifest; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];

  const description = typeof fm.description === "string" ? fm.description.trim() : "";
  if (!description) {
    diagnostics.push({ level: "error", message: "missing required 'description' field" });
  } else if (description.length > 1024) {
    diagnostics.push({
      level: "warn",
      message: `description is ${description.length} chars (spec recommends ≤ 1024)`,
    });
  }

  let name = typeof fm.name === "string" ? fm.name.trim() : "";
  if (!name && dirName) {
    name = dirName;
    diagnostics.push({ level: "warn", message: "missing 'name'; using the directory name" });
  }
  if (!name) {
    diagnostics.push({ level: "error", message: "missing required 'name' field" });
  } else {
    if (name.length > 64) {
      diagnostics.push({ level: "warn", message: `name is ${name.length} chars (spec max is 64)` });
    }
    if (!NAME_RE.test(name)) {
      diagnostics.push({
        level: "warn",
        message: `name '${name}' should be lowercase alphanumeric with single hyphens`,
      });
    }
    if (dirName && name !== dirName) {
      diagnostics.push({
        level: "warn",
        message: `name '${name}' does not match its directory '${dirName}'`,
      });
    }
  }

  if (diagnostics.some((d) => d.level === "error")) {
    return { diagnostics };
  }

  const manifest: SkillManifest = {
    name,
    description,
    license: typeof fm.license === "string" ? fm.license : undefined,
    compatibility: typeof fm.compatibility === "string" ? fm.compatibility : undefined,
    metadata: isStringMap(fm.metadata) ? fm.metadata : undefined,
    allowedTools: typeof fm["allowed-tools"] === "string" ? fm["allowed-tools"] : undefined,
  };
  return { manifest, diagnostics };
}

// ---- internals ----

function parseFrontmatterBlock(block: string): Frontmatter {
  const out: Frontmatter = {};
  const lines = block.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    i++;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    // Indented lines without a preceding map parent are stray — skip them.
    if (/^\s/.test(line)) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    // Split on the FIRST colon only, so unquoted values containing colons
    // (e.g. "Use when: foo") survive — the leniency the spec guide recommends.
    const value = line.slice(idx + 1).trim();
    if (key === "") continue;
    if (value === "") {
      // A bare "key:" introduces a nested map (e.g. `metadata:`). Gather the
      // indented child entries that follow.
      const map: Record<string, string> = {};
      while (i < lines.length && /^\s+\S/.test(lines[i] ?? "")) {
        const child = lines[i] ?? "";
        i++;
        const cidx = child.indexOf(":");
        if (cidx === -1) continue;
        const ck = child.slice(0, cidx).trim();
        const cv = stripQuotes(child.slice(cidx + 1).trim());
        if (ck) map[ck] = cv;
      }
      out[key] = map;
    } else {
      out[key] = stripQuotes(value);
    }
  }
  return out;
}

function stripQuotes(v: string): string {
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

function isStringMap(v: unknown): v is Record<string, string> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === "string")
  );
}
