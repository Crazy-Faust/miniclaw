import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultPidPath, defaultSocketPath, readPid } from "@miniclaw/gateway";

import { loadConfig } from "./config.ts";

// Re-enter the CLI entry point so the child's argv dispatch routes to
// `daemon run`. Pointing the child at this module directly would just
// re-import it and exit — there is no top-level handler here. Mirrors the
// spawn trick in daemon.ts.
const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");

export interface EnsureDaemonOpts {
  /** Max time to wait for the socket to appear after a spawn (ms). */
  timeoutMs?: number;
  /**
   * Config preflight, run in the *parent* so a bad/missing API key fails
   * fast in the foreground instead of inside a silently-crashing detached
   * child. Injectable for tests; defaults to loadConfig().
   */
  preflight?: () => void;
  /**
   * Spawn the detached `daemon run` child. Injectable for tests; the default
   * forks the real CLI with stdio redirected to log files under MINICLAW_HOME.
   */
  spawnDaemon?: (home: string) => void | Promise<void>;
}

/** Thrown when a freshly-spawned daemon never opens its socket in time. */
export class DaemonStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonStartError";
  }
}

/**
 * Ensure a gateway daemon is running and return its socket path. This is the
 * single "however a session starts, make sure there is a daemon" entry point
 * shared by the repl, one-shot, and chat clients.
 *
 * In order:
 *   1. config preflight (fail fast in the parent)
 *   2. if the recorded pid is alive *and* the socket accepts a connection, reuse it
 *   3. otherwise spawn `daemon run` detached, with stdio -> log files
 *   4. poll-connect the socket for up to ~10s; throw with the err-log tail on timeout
 */
export async function ensureDaemon(opts: EnsureDaemonOpts = {}): Promise<string> {
  (opts.preflight ?? defaultPreflight)(); // (1)

  const socketPath = defaultSocketPath();
  const pid = readPid(defaultPidPath());
  if (pid && isAlive(pid) && (await canConnect(socketPath))) return socketPath; // (2)

  const home = process.env.MINICLAW_HOME ?? join(homedir(), ".miniclaw");
  await (opts.spawnDaemon ?? spawnDetachedDaemon)(home); // (3)

  const timeoutMs = opts.timeoutMs ?? 10_000;
  if (await waitForSocket(socketPath, timeoutMs)) return socketPath; // (4)

  const tail = safeTail(join(home, "daemon.err.log"), 20);
  throw new DaemonStartError(
    `daemon failed to start within ${Math.round(timeoutMs / 1000)}s.\n${tail}`,
  );
}

function defaultPreflight(): void {
  // Reads env, creates MINICLAW_HOME, and throws a clear error on a missing
  // API key — all in the parent process.
  loadConfig();
}

function spawnDetachedDaemon(home: string): void {
  mkdirSync(home, { recursive: true });
  // Redirect to log files (not "ignore") so a boot failure in the detached
  // child is diagnosable — we tail daemon.err.log on a socket timeout.
  const out = openSync(join(home, "daemon.out.log"), "a");
  const err = openSync(join(home, "daemon.err.log"), "a");
  const child = spawn(process.execPath, [...process.execArgv, ENTRY, "daemon", "run"], {
    detached: true,
    stdio: ["ignore", out, err],
    env: process.env,
  });
  child.unref();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolve true if something is accepting connections on the socket. */
function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection(socketPath);
    const settle = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => settle(true));
    sock.once("error", () => settle(false));
  });
}

async function waitForSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await canConnect(socketPath)) return true;
    await delay(150);
  } while (Date.now() < deadline);
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeTail(path: string, lines: number): string {
  try {
    const all = readFileSync(path, "utf8").split("\n");
    return all.slice(Math.max(0, all.length - lines)).join("\n").trim();
  } catch {
    return "(no daemon.err.log)";
  }
}
