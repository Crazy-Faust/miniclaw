import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillContext } from "@miniclaw/core";
import { createShellSkill, shellSkill } from "../src/index.ts";

// Streaming = the `onStream` callback on SkillContext fires with each chunk
// of stdout/stderr as it's produced, before the skill returns. Without this
// long-running commands would be silent until completion.

function makeCtx(
  opts: { workspaceRoot?: string; onStream?: SkillContext["onStream"] } = {},
): SkillContext {
  return {
    memory: { add: () => 0, search: () => [], listRecent: () => [] },
    audit: { logToolCall: () => {} },
    dbPath: "/dev/null",
    workspaceRoot: opts.workspaceRoot,
    onStream: opts.onStream,
  };
}

describe("shellSkill streaming", () => {
  it("invokes onStream with stdout chunks as they arrive", async () => {
    const streamed: Array<{ kind: string; text: string }> = [];
    const res = await shellSkill.execute(
      { bin: "echo", args: ["hello-streamed"] },
      makeCtx({ onStream: (kind, chunk) => streamed.push({ kind, text: chunk }) }),
    );
    expect(res.ok).toBe(true);
    // echo produces a single stdout chunk ending with a newline.
    expect(streamed.length).toBeGreaterThan(0);
    const all = streamed.filter((s) => s.kind === "stdout").map((s) => s.text).join("");
    expect(all).toContain("hello-streamed");
  });

  it("works when onStream is not provided (back-compat)", async () => {
    const res = await shellSkill.execute({ bin: "echo", args: ["plain"] }, makeCtx());
    expect(res.ok).toBe(true);
    expect(res.output).toContain("plain");
  });

  it("a misbehaving onStream callback does not crash the command", async () => {
    const res = await shellSkill.execute(
      { bin: "echo", args: ["resilient"] },
      makeCtx({
        onStream: () => {
          throw new Error("ui sink boom");
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("resilient");
  });

  it("streams stdout chunks incrementally during a long-running command", async () => {
    // Use a custom skill with `node` allowed so we can emit chunks with delays.
    // Each setTimeout writes "tick", giving us multiple distinct chunks rather
    // than one batched flush at process exit.
    const skill = createShellSkill({
      timeoutMs: 5_000,
      allowlist: new Set(["node"]),
    });

    const dir = mkdtempSync(join(tmpdir(), "miniclaw-stream-"));
    try {
      const script = join(dir, "tick.mjs");
      writeFileSync(
        script,
        `
          let n = 0;
          const id = setInterval(() => {
            process.stdout.write("tick\\n");
            if (++n >= 3) { clearInterval(id); }
          }, 50);
        `,
        "utf8",
      );

      const order: Array<{ at: number; text: string }> = [];
      const t0 = Date.now();
      const res = await skill.execute(
        { bin: "node", args: [script] },
        makeCtx({
          workspaceRoot: dir,
          onStream: (kind, chunk) => {
            if (kind === "stdout") order.push({ at: Date.now() - t0, text: chunk });
          },
        }),
      );
      expect(res.ok).toBe(true);
      const ticks = order.flatMap((o) => o.text.split("\n").filter((s) => s === "tick"));
      expect(ticks.length).toBe(3);
      // At least one chunk should arrive before the process closes.
      const totalElapsed = Date.now() - t0;
      const firstChunkAt = order[0]?.at ?? totalElapsed;
      expect(firstChunkAt).toBeLessThan(totalElapsed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shellSkill timeout", () => {
  it("kills a command that exceeds timeoutMs and reports timeout", async () => {
    const skill = createShellSkill({
      timeoutMs: 200,
      allowlist: new Set(["node"]),
    });

    const t0 = Date.now();
    const res = await skill.execute(
      { bin: "node", args: ["-e", "setTimeout(() => {}, 5000)"] },
      makeCtx(),
    );
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/timeout after 200ms/);
    expect(res.output).toMatch(/signal=SIGKILL/);
    // Must terminate well under the child's own 5s wait; allow generous margin.
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("shellSkill output truncation", () => {
  it("truncates stdout output beyond maxOutputBytes (default 64KiB)", async () => {
    // Produce ~70KiB on stdout, all at once, via a custom-allowlist skill.
    const skill = createShellSkill({
      timeoutMs: 5_000,
      allowlist: new Set(["node"]),
    });
    const res = await skill.execute(
      { bin: "node", args: ["-e", "process.stdout.write('a'.repeat(70 * 1024))"] },
      makeCtx(),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/\(output truncated\)/);
    // Stored stdout body should be capped — count only the 'a's between the
    // stdout marker and the next marker line.
    const m = /--- stdout ---\n(a+)/.exec(res.output);
    expect(m).not.toBeNull();
    if (m && m[1]) {
      expect(m[1].length).toBeLessThanOrEqual(64 * 1024);
      expect(m[1].length).toBeGreaterThan(60 * 1024);
    }
  });

  it("honors a custom maxOutputBytes", async () => {
    const skill = createShellSkill({
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
      allowlist: new Set(["node"]),
    });
    const res = await skill.execute(
      { bin: "node", args: ["-e", "process.stdout.write('b'.repeat(4096))"] },
      makeCtx(),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/\(output truncated\)/);
    const m = /--- stdout ---\n(b+)/.exec(res.output);
    expect(m).not.toBeNull();
    if (m && m[1]) {
      expect(m[1].length).toBe(1024);
    }
  });
});

describe("shellSkill workspace path-escape on args containing /", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "miniclaw-shell-escape-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses an arg that climbs out via interleaved .. segments", async () => {
    // Arg contains '/' so the path guard kicks in. The lexical resolution
    // ends up outside the workspace, so the call must be refused before
    // anything is spawned.
    const res = await shellSkill.execute(
      { bin: "cat", args: ["sub/../../escape.txt"] },
      makeCtx({ workspaceRoot: root }),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/refused/);
    expect(res.output).toMatch(/outside the workspace root/);
  });

  it("refuses an absolute path arg that points elsewhere on the filesystem", async () => {
    const res = await shellSkill.execute(
      { bin: "cat", args: ["/etc/hosts"] },
      makeCtx({ workspaceRoot: root }),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/refused/);
    expect(res.output).toMatch(/outside the workspace root/);
  });

  it("refuses a mixed-position escape arg (escape arg follows a benign flag)", async () => {
    const res = await shellSkill.execute(
      { bin: "ls", args: ["-la", "../../etc"] },
      makeCtx({ workspaceRoot: root }),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/refused/);
  });

  it("permits a deep relative path that stays inside the workspace", async () => {
    writeFileSync(join(root, "hi.txt"), "ok");
    const res = await shellSkill.execute(
      { bin: "cat", args: ["./hi.txt"] },
      makeCtx({ workspaceRoot: root }),
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain("ok");
  });
});
