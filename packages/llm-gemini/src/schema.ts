// Gemini's tool/function declarations accept a *subset* of OpenAPI 3.0
// (https://ai.google.dev/api/caching#Schema). zod-to-json-schema emits
// standard JSON Schema draft-7, which includes fields Gemini rejects with
// 400 INVALID_ARGUMENT — most commonly `additionalProperties` (zod adds
// it to every object) and `exclusiveMinimum` (emitted for `.positive()`,
// `.int().min(N)`, etc.).
//
// We walk the schema and KEEP ONLY the fields on Gemini's allow-list.
// Whitelist > denylist: if zod / future tooling emits a new draft field
// Gemini doesn't know, we strip it for free.

// Source: https://ai.google.dev/api/caching#Schema, cross-checked against
// gemini-2.0-flash 400 responses.
const ALLOWED_FIELDS = new Set<string>([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "properties",
  "required",
  "minProperties",
  "maxProperties",
  "propertyOrdering",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "example",
  "default",
  "anyOf",
]);

// Fields whose VALUES are user data, not nested schemas. We must not
// apply the schema-keyword whitelist to their contents — that would
// strip user-defined property names ("name", "count", …) under
// `properties`, or strip keys of a `default` object literal.
const DATA_FIELDS = new Set<string>(["default", "example", "enum"]);

// Strip Gemini-unsupported fields recursively. Returns a new object —
// never mutates the input, so the same ToolSpec can also be sent to
// Anthropic / OpenAI in the same process without surprise.
export function sanitizeForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeForGemini);
  if (schema === null || typeof schema !== "object") return schema;

  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(src)) {
    if (!ALLOWED_FIELDS.has(key)) continue;

    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      // `properties` is a map whose keys are user-chosen names. Don't run
      // the whitelist over those names — recurse only into the value
      // (which IS a schema).
      const cleanProps: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        cleanProps[propName] = sanitizeForGemini(propSchema);
      }
      out[key] = cleanProps;
    } else if (DATA_FIELDS.has(key)) {
      // Pass data values through as-is. Filtering them would corrupt
      // defaults like `{ kind: "note", tags: [] }`.
      out[key] = value;
    } else {
      out[key] = sanitizeForGemini(value);
    }
  }

  // const → single-element enum. Gemini supports `enum` (string only),
  // not `const`. Only safe for string constants.
  if ("const" in src && typeof src.const === "string" && !("enum" in out)) {
    out.enum = [src.const];
    if (!("type" in out)) out.type = "string";
  }

  return out;
}
