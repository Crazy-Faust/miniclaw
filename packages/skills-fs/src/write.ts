import { writeFile, rename, mkdir, unlink, stat } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { fail, ok, type Skill } from "@miniclaw/core";
import { resolveInsideWorkspace } from "./sandbox.ts";

export const MAX_WRITE_BYTES = 256 * 1024;

const WriteFileParams = z.object({
  path: z
    .string()
    .min(1)
    .describe("File path, absolute or relative to the workspace root."),
  content: z
    .string()
    .describe("UTF-8 text to write. Size capped at 256 KiB."),
  createDirs: z
    .boolean()
    .default(false)
    .describe("If true, create parent directories as needed."),
});

export const writeFileSkill: Skill<z.infer<typeof WriteFileParams>> = {
  name: "write_file",
  description:
    `Write a UTF-8 text file inside the workspace, atomically (tmp file + rename). ` +
    `Refuses paths that resolve outside the workspace root (including via symlinks). ` +
    `Refuses content larger than ${MAX_WRITE_BYTES} bytes. ` +
    `Requires user confirmation before running.`,
  parameters: WriteFileParams,
  requiresConfirmation: true,
  async execute(args, ctx) {
    if (!ctx.workspaceRoot) return fail("no workspace root configured");

    const byteLen = Buffer.byteLength(args.content, "utf8");
    if (byteLen > MAX_WRITE_BYTES) {
      return fail(
        `refused: content is ${byteLen} bytes, exceeds cap of ${MAX_WRITE_BYTES}`,
      );
    }

    // Guard the target path itself.
    const targetCheck = resolveInsideWorkspace(args.path, ctx.workspaceRoot);
    if (!targetCheck.ok) return fail(`refused: ${targetCheck.reason}`);

    // The parent directory must also resolve inside the workspace. If the
    // target is a symlink pointing out, resolveInsideWorkspace already
    // catches it; but if only the parent exists (target is new), we re-check
    // the parent through any symlinks.
    const parentRel = dirname(args.path) || ".";
    const parentCheck = resolveInsideWorkspace(parentRel, ctx.workspaceRoot);
    if (!parentCheck.ok) return fail(`refused: ${parentCheck.reason}`);

    try {
      if (args.createDirs) {
        await mkdir(parentCheck.resolvedPath, { recursive: true });
      }

      const finalPath = join(parentCheck.resolvedPath, basename(args.path));
      const tmpPath = `${finalPath}.${randomBytes(6).toString("hex")}.tmp`;

      await writeFile(tmpPath, args.content, { encoding: "utf8", flag: "wx" });
      try {
        await rename(tmpPath, finalPath);
      } catch (renameErr) {
        // Best-effort cleanup of the tmp file if rename failed.
        await unlink(tmpPath).catch(() => {});
        throw renameErr;
      }

      const st = await stat(finalPath).catch(() => null);
      return ok(
        `wrote path=${args.path} bytes=${byteLen}${st ? ` size=${st.size}` : ""}`,
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      return fail(`write error: ${code}`);
    }
  },
};
