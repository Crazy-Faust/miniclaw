import { describe, expect, it } from "vitest";
import { parseSkillMd, validateManifest } from "../src/manifest.ts";

describe("parseSkillMd", () => {
  it("splits frontmatter from body and parses scalar + nested-map fields", () => {
    const md = [
      "---",
      "name: demo",
      "description: A demo skill: it does things", // unquoted colon in value
      'license: MIT',
      "metadata:",
      "  author: me",
      '  version: "1.0"',
      "---",
      "# Title",
      "",
      "Body text.",
    ].join("\n");
    const parsed = parseSkillMd(md);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.frontmatter.name).toBe("demo");
    // The colon after "skill" must survive — split on the first colon only.
    expect(parsed.frontmatter.description).toBe("A demo skill: it does things");
    expect(parsed.frontmatter.license).toBe("MIT");
    expect(parsed.frontmatter.metadata).toEqual({ author: "me", version: "1.0" });
    expect(parsed.body).toBe("# Title\n\nBody text.");
  });

  it("returns an error when the leading frontmatter block is missing", () => {
    const parsed = parseSkillMd("# Just markdown, no frontmatter\n");
    expect("error" in parsed).toBe(true);
  });

  it("handles a frontmatter-only file with an empty body", () => {
    const parsed = parseSkillMd("---\nname: x\ndescription: y\n---\n");
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.body).toBe("");
  });
});

describe("validateManifest", () => {
  it("accepts a valid manifest with no diagnostics", () => {
    const { manifest, diagnostics } = validateManifest(
      { name: "pdf-tools", description: "Work with PDFs." },
      "pdf-tools",
    );
    expect(manifest?.name).toBe("pdf-tools");
    expect(diagnostics).toHaveLength(0);
  });

  it("skips (error) when description is missing", () => {
    const { manifest, diagnostics } = validateManifest({ name: "x" }, "x");
    expect(manifest).toBeUndefined();
    expect(diagnostics.some((d) => d.level === "error")).toBe(true);
  });

  it("warns but loads when the name does not match the directory", () => {
    const { manifest, diagnostics } = validateManifest(
      { name: "foo", description: "d" },
      "bar",
    );
    expect(manifest?.name).toBe("foo");
    expect(diagnostics.some((d) => d.level === "warn" && /does not match/.test(d.message))).toBe(true);
  });

  it("falls back to the directory name when name is absent", () => {
    const { manifest, diagnostics } = validateManifest({ description: "d" }, "my-skill");
    expect(manifest?.name).toBe("my-skill");
    expect(diagnostics.some((d) => d.level === "warn")).toBe(true);
  });

  it("warns on an invalid name character set but still loads", () => {
    const { manifest, diagnostics } = validateManifest(
      { name: "Foo_Bar", description: "d" },
      "Foo_Bar",
    );
    expect(manifest?.name).toBe("Foo_Bar");
    expect(diagnostics.some((d) => /lowercase alphanumeric/.test(d.message))).toBe(true);
  });
});
