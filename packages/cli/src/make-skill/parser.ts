// Parser for the tiny parameter-spec mini-language used by /make_skill.
//
// Format:
//   name:type[, name:type, ...]
//
// Types:
//   string | number | boolean | string[] | number[]
// Append `?` after the type to mark the parameter as optional.
//
// Example: "url:string, timeout:number?, headers:string[]?"

export type ParamType = "string" | "number" | "boolean" | "string[]" | "number[]";

export interface ParamSpec {
  name: string;
  type: ParamType;
  optional: boolean;
}

const VALID_TYPES: ReadonlySet<ParamType> = new Set([
  "string", "number", "boolean", "string[]", "number[]",
]);

const NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function parseParamSpec(spec: string): ParamSpec[] {
  const trimmed = spec.trim();
  if (trimmed === "") return [];

  const parts = trimmed.split(",").map((p) => p.trim()).filter(Boolean);
  const out: ParamSpec[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    const colon = part.indexOf(":");
    if (colon === -1) {
      throw new Error(`expected 'name:type' but got '${part}'`);
    }
    const name = part.slice(0, colon).trim();
    let rawType = part.slice(colon + 1).trim();

    if (!NAME_PATTERN.test(name)) {
      throw new Error(`invalid parameter name: '${name}'`);
    }
    if (seen.has(name)) {
      throw new Error(`duplicate parameter name: '${name}'`);
    }
    seen.add(name);

    let optional = false;
    if (rawType.endsWith("?")) {
      optional = true;
      rawType = rawType.slice(0, -1);
    }
    if (!VALID_TYPES.has(rawType as ParamType)) {
      throw new Error(
        `unknown type '${rawType}'; allowed: ${[...VALID_TYPES].join(", ")}`,
      );
    }
    out.push({ name, type: rawType as ParamType, optional });
  }
  return out;
}

/** Translate a ParamSpec into the zod expression used inside z.object({ ... }). */
export function paramToZod(p: ParamSpec): string {
  const base =
    p.type === "string" ? "z.string()"
    : p.type === "number" ? "z.number()"
    : p.type === "boolean" ? "z.boolean()"
    : p.type === "string[]" ? "z.array(z.string())"
    : "z.array(z.number())";
  const opt = p.optional ? ".optional()" : "";
  return `${base}${opt}.describe("TODO: describe '${p.name}'")`;
}
