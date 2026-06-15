import { spawn } from "node:child_process";
import { fail, ok, type ToolResult } from "@miniclaw/core";

export interface RunProcessOpts {
  /** Hard timeout for the process. */
  timeoutMs: number;
  /** Combined per-stream output cap before truncation. */
  maxOutputBytes: number;
  /** Working directory for the child process. */
  cwd?: string;
  /** Incremental output sink (raw chunks, before truncation). */
  onStream?: (kind: "stdout" | "stderr", chunk: string) => void;
}

/**
 * Spawn `bin` with `args` (no shell, no interpolation), capture stdout/stderr
 * with a byte cap, enforce a hard timeout, and format the result the way the
 * agent expects: an `exit_code=…` header followed by a `<tool_output>` block.
 * Shared by the shell skill and the bundled-script runner.
 */
export function runProcess(bin: string, args: string[], opts: RunProcessOpts): Promise<ToolResult> {
  const { timeoutMs, maxOutputBytes, cwd, onStream } = opts;
  return new Promise((resolve) => {
    const child = spawn(bin, args, { shell: false, cwd });
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    const stdoutRef = { v: 0 };
    const stderrRef = { v: 0 };
    let truncated = false;
    let timedOut = false;

    const collect = (
      kind: "stdout" | "stderr",
      chunks: Uint8Array[],
      lenRef: { v: number },
    ) => (c: Uint8Array) => {
      // Stream the raw chunk to the UI before we truncate or buffer.
      if (onStream) {
        try {
          onStream(kind, Buffer.from(c.buffer, c.byteOffset, c.byteLength).toString("utf8"));
        } catch {
          // Don't let a misbehaving UI sink crash the command.
        }
      }
      if (lenRef.v >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const room = maxOutputBytes - lenRef.v;
      if (c.length > room) {
        truncated = true;
        chunks.push(c.subarray(0, room));
        lenRef.v += room;
      } else {
        chunks.push(c);
        lenRef.v += c.length;
      }
    };
    child.stdout.on("data", collect("stdout", stdoutChunks, stdoutRef));
    child.stderr.on("data", collect("stderr", stderrChunks, stderrRef));

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve(fail(`spawn error: ${err.message}`));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const decode = (chunks: Uint8Array[]): string =>
        Buffer.concat(
          chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)),
        ).toString("utf8");
      const body =
        `exit_code=${code ?? "null"}${signal ? ` signal=${signal}` : ""}` +
        `${timedOut ? ` (timeout after ${timeoutMs}ms)` : ""}` +
        `${truncated ? " (output truncated)" : ""}\n` +
        `<tool_output>\n` +
        `--- stdout ---\n${decode(stdoutChunks)}\n` +
        `--- stderr ---\n${decode(stderrChunks)}\n` +
        `</tool_output>`;
      resolve(code === 0 && !timedOut ? ok(body) : fail(body));
    });
  });
}
