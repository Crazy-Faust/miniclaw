import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@miniclaw/agent";
import { Harness, type IOAdapter } from "@miniclaw/harness";

import { makeSkillCommand, type SkillSpec } from "../src/make-skill/index.ts";

type CreateFn = (spec: SkillSpec, skillsDir: string) => { skillDir: string; files: string[] };

// Drive the /make_skill wizard through the harness with a scripted IO. The file
// effect is mocked so we only assert on the prompts and the SkillSpec the wizard
// builds; the real file operations are tested in make-skill-files.test.ts.

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
  let skillsDir: string;

  beforeEach(() => {
    skillsDir = mkdtempSync(join(tmpdir(), "miniclaw-wizard-"));
  });
  afterEach(() => {
    rmSync(skillsDir, { recursive: true, force: true });
  });

  it("walks the prompts and builds a SkillSpec with a bundled script", async () => {
    const io = new ScriptedIO([
      "/make_skill",
      "pdf-tools",          // name
      "Work with PDFs.",    // description
      "python",             // bundle a script? -> python
      "",                   // script file name -> accept default run.py
      null,                 // EOF terminates the loop
    ]);
    const create = vi.fn<CreateFn>(() => ({
      skillDir: join(skillsDir, "pdf-tools"),
      files: ["SKILL.md", "scripts/run.py"],
    }));

    const cmd = makeSkillCommand({ skillsDir, effects: { create } });
    await new Harness({ agent: noopAgent, io, metaCommands: [cmd] }).run();

    expect(create).toHaveBeenCalledTimes(1);
    const spec = create.mock.calls[0]![0]!;
    expect(spec).toMatchObject({
      name: "pdf-tools",
      description: "Work with PDFs.",
      script: { language: "python", fileName: "run.py" },
    });
    expect(io.text).toMatch(/Created/);
    expect(io.text).toMatch(/run_skill_script/);
  });

  it("builds a script-less SkillSpec when the user answers 'none'", async () => {
    const io = new ScriptedIO([
      "/make_skill",
      "notes",
      "Keep notes.",
      "none",
      null,
    ]);
    const create = vi.fn<CreateFn>(() => ({ skillDir: join(skillsDir, "notes"), files: ["SKILL.md"] }));

    const cmd = makeSkillCommand({ skillsDir, effects: { create } });
    await new Harness({ agent: noopAgent, io, metaCommands: [cmd] }).run();

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]!.script).toBeUndefined();
  });

  it("re-prompts on an invalid name and accepts the corrected value", async () => {
    const io = new ScriptedIO([
      "/make_skill",
      "Bad Name",            // rejected (space + uppercase)
      "good-name",           // accepted
      "desc",
      "none",
      null,
    ]);
    const create = vi.fn<CreateFn>(() => ({ skillDir: "", files: [] }));

    const cmd = makeSkillCommand({ skillsDir, effects: { create } });
    await new Harness({ agent: noopAgent, io, metaCommands: [cmd] }).run();

    expect(io.text).toMatch(/error: must be lowercase kebab-case/);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]!.name).toBe("good-name");
  });

  it("cancels cleanly on EOF without calling the effect", async () => {
    const io = new ScriptedIO(["/make_skill", null]);
    const create = vi.fn<CreateFn>(() => ({ skillDir: "", files: [] }));

    const cmd = makeSkillCommand({ skillsDir, effects: { create } });
    await new Harness({ agent: noopAgent, io, metaCommands: [cmd] }).run();

    expect(create).not.toHaveBeenCalled();
  });

  it("surfaces a thrown effect as 'refused: ...'", async () => {
    const io = new ScriptedIO([
      "/make_skill",
      "pdf-tools",
      "desc",
      "none",
      null,
    ]);
    const create = vi.fn<CreateFn>(() => {
      throw new Error("directory already exists: x");
    });

    const cmd = makeSkillCommand({ skillsDir, effects: { create } });
    await new Harness({ agent: noopAgent, io, metaCommands: [cmd] }).run();

    expect(io.text).toMatch(/refused: directory already exists/);
  });
});
