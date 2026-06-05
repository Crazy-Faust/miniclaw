import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@miniclaw/agent";
import { Harness, type IOAdapter } from "@miniclaw/harness";

import { makeSkillCommand, type SkillSpec } from "../src/make-skill/index.ts";

type CreateFn = (spec: SkillSpec, root: string) => { packageDir: string; files: string[] };
type PatchFn = (spec: SkillSpec, root: string) => { changed: boolean };

// Drive the /make_skill wizard through the harness with a scripted IO.
// The actual file effects are mocked so we only assert on the prompts and
// the side-effect calls — the real file operations are tested separately
// in make-skill-files.test.ts.

class ScriptedIO implements IOAdapter {
  outputs: string[] = [];
  prompts: string[] = [];
  private readonly inputs: (string | null)[];
  closed = false;

  constructor(inputs: (string | null)[]) {
    this.inputs = [...inputs];
  }
  async readLine(prompt: string): Promise<string | null> {
    this.prompts.push(prompt);
    return this.inputs.length === 0 ? null : this.inputs.shift()!;
  }
  write(text: string): void { this.outputs.push(text); }
  close(): void { this.closed = true; }
  get text(): string { return this.outputs.join(""); }
}

const noopAgent = { runTurn: async () => ({ toolCalls: [], finalText: "" }) } as unknown as Agent;

describe("makeSkillCommand wizard", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "miniclaw-wizard-"));
    mkdirSync(join(root, "packages"), { recursive: true });
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("walks through the prompts and calls each effect once on the happy path", async () => {
    const io = new ScriptedIO([
      "/make_skill",
      "fetch-url",            // pkg name
      "",                     // tool name — accept suggestion
      "Fetch a URL.",         // description
      "url:string",           // params
      null,                   // EOF terminates the loop
    ]);
    const create = vi.fn<CreateFn>(() => ({
      packageDir: join(root, "packages", "skills-fetch-url"),
      files: ["package.json", "tsconfig.json", "src/skill.ts", "src/index.ts", "tests/skill.test.ts"],
    }));
    const patchSkills = vi.fn<PatchFn>(() => ({ changed: true }));
    const patchPackageJson = vi.fn<PatchFn>(() => ({ changed: true }));

    const cmd = makeSkillCommand({
      repoRoot: root,
      effects: { create, patchSkills, patchPackageJson },
    });

    await new Harness({ agent: noopAgent, io, metaCommands: [cmd] }).run();

    expect(create).toHaveBeenCalledTimes(1);
    expect(patchSkills).toHaveBeenCalledTimes(1);
    expect(patchPackageJson).toHaveBeenCalledTimes(1);

    // First arg is the SkillSpec; verify the wizard built it right.
    const spec = create.mock.calls[0]![0]!;
    expect(spec).toMatchObject({
      pkgName: "fetch-url",
      toolName: "fetch_url",     // derived from blank input + suggestion
      description: "Fetch a URL.",
      params: [{ name: "url", type: "string", optional: false }],
    });

    expect(io.text).toMatch(/Created/);
    expect(io.text).toMatch(/Next steps/);
  });

  it("re-prompts on invalid pkg name and accepts the corrected value", async () => {
    const io = new ScriptedIO([
      "/make_skill",
      "BadName",              // rejected
      "fetch-url",            // accepted
      "fetch_url",
      "desc",
      "",                     // empty params
      null,
    ]);
    const create = vi.fn<CreateFn>(() => ({
      packageDir: "",
      files: [],
    }));

    const cmd = makeSkillCommand({
      repoRoot: root,
      effects: {
        create,
        patchSkills: vi.fn<PatchFn>(() => ({ changed: true })),
        patchPackageJson: vi.fn<PatchFn>(() => ({ changed: true })),
      },
    });

    await new Harness({ agent: noopAgent, io, metaCommands: [cmd] }).run();

    expect(io.text).toMatch(/error: must be lowercase kebab-case/);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]!.pkgName).toBe("fetch-url");
    // Empty params parsed as []
    expect(create.mock.calls[0]![0]!.params).toEqual([]);
  });

  it("cancels cleanly on EOF mid-prompt without calling effects", async () => {
    const io = new ScriptedIO([
      "/make_skill",
      null,                   // EOF before answering the first prompt
    ]);
    const create = vi.fn<CreateFn>(() => ({ packageDir: "", files: [] }));

    const cmd = makeSkillCommand({
      repoRoot: root,
      effects: {
        create,
        patchSkills: vi.fn<PatchFn>(() => ({ changed: false })),
        patchPackageJson: vi.fn<PatchFn>(() => ({ changed: false })),
      },
    });

    await new Harness({ agent: noopAgent, io, metaCommands: [cmd] }).run();

    expect(create).not.toHaveBeenCalled();
  });

  it("surfaces a thrown effect (e.g. directory exists) as 'refused: ...'", async () => {
    const io = new ScriptedIO([
      "/make_skill",
      "fetch-url",
      "fetch_url",
      "desc",
      "",
      null,
    ]);
    const create = vi.fn<CreateFn>(() => {
      throw new Error("directory already exists: x");
    });

    const cmd = makeSkillCommand({
      repoRoot: root,
      effects: {
        create,
        patchSkills: vi.fn<PatchFn>(() => ({ changed: false })),
        patchPackageJson: vi.fn<PatchFn>(() => ({ changed: false })),
      },
    });

    await new Harness({ agent: noopAgent, io, metaCommands: [cmd] }).run();

    expect(io.text).toMatch(/refused: directory already exists/);
  });
});
