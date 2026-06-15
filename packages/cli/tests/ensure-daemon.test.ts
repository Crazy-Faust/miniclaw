import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultPidPath, defaultSocketPath, writePid } from "@miniclaw/gateway";

import { DaemonStartError, ensureDaemon } from "../src/ensure-daemon.ts";

// Each test points MINICLAW_HOME / _SOCKET / _PID at a throwaway dir and
// injects preflight + spawnDaemon, so nothing here boots a real daemon or
// needs a provider key.

function listen(socketPath: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("ensureDaemon", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "miniclaw-ensure-"));
    for (const k of ["MINICLAW_HOME", "MINICLAW_SOCKET", "MINICLAW_PID"]) saved[k] = process.env[k];
    process.env.MINICLAW_HOME = dir;
    process.env.MINICLAW_SOCKET = join(dir, "miniclaw.sock");
    process.env.MINICLAW_PID = join(dir, "miniclaw.pid");
  });

  afterEach(() => {
    for (const k of ["MINICLAW_HOME", "MINICLAW_SOCKET", "MINICLAW_PID"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("reuses a live daemon without spawning", async () => {
    const server = await listen(defaultSocketPath());
    writePid(defaultPidPath(), process.pid); // the test process is alive
    let spawned = false;
    try {
      const sock = await ensureDaemon({
        preflight: () => {},
        spawnDaemon: () => { spawned = true; },
      });
      expect(sock).toBe(defaultSocketPath());
      expect(spawned).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("spawns and resolves once the socket appears", async () => {
    let server: Server | null = null;
    let spawned = false;
    try {
      const sock = await ensureDaemon({
        preflight: () => {},
        timeoutMs: 2000,
        spawnDaemon: async () => {
          spawned = true;
          server = await listen(defaultSocketPath()); // daemon "comes up"
        },
      });
      expect(spawned).toBe(true);
      expect(sock).toBe(defaultSocketPath());
    } finally {
      if (server) await closeServer(server);
    }
  });

  it("throws with the err-log tail when the socket never appears", async () => {
    writeFileSync(join(dir, "daemon.err.log"), "boot failed: provider key invalid\n", "utf8");
    const err = await ensureDaemon({
      preflight: () => {},
      timeoutMs: 300,
      spawnDaemon: () => {}, // never opens a socket
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonStartError);
    expect((err as Error).message).toMatch(/provider key invalid/);
  });

  it("runs the config preflight before spawning (fail fast in the parent)", async () => {
    let spawned = false;
    await expect(
      ensureDaemon({
        preflight: () => { throw new Error("ANTHROPIC_API_KEY is not set"); },
        spawnDaemon: () => { spawned = true; },
      }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(spawned).toBe(false);
  });
});
