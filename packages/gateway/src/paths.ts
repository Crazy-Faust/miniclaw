import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = () => process.env.MINICLAW_HOME ?? join(homedir(), ".miniclaw");

export function defaultSocketPath(): string {
  return process.env.MINICLAW_SOCKET ?? join(HOME(), "miniclaw.sock");
}

export function defaultPidPath(): string {
  return process.env.MINICLAW_PID ?? join(HOME(), "miniclaw.pid");
}

export function writePid(pidPath: string, pid: number): void {
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, String(pid), "utf8");
}

export function readPid(pidPath: string): number | null {
  if (!existsSync(pidPath)) return null;
  const raw = readFileSync(pidPath, "utf8").trim();
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function removePid(pidPath: string): void {
  try {
    rmSync(pidPath, { force: true });
  } catch {
    // Nothing to do.
  }
}
