import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/argv.ts";

describe("parseArgs", () => {
  it("returns the interactive defaults when argv is empty", () => {
    expect(parseArgs([])).toEqual({
      mode: { kind: "repl", stateless: false, ephemeral: false },
    });
  });

  it("joins positionals into a single one-shot prompt", () => {
    expect(parseArgs(["what", "is", "the", "time"])).toEqual({
      mode: {
        kind: "one-shot",
        prompt: "what is the time",
        stateless: false,
        ephemeral: false,
      },
    });
  });

  it("recognizes --stateless and --ephemeral on REPL", () => {
    expect(parseArgs(["--stateless"])).toEqual({
      mode: { kind: "repl", stateless: true, ephemeral: false },
    });
    expect(parseArgs(["--ephemeral"])).toEqual({
      mode: { kind: "repl", stateless: false, ephemeral: true },
    });
  });

  it("--help and -h both produce a help mode", () => {
    expect(parseArgs(["--help"])).toEqual({ mode: { kind: "help" } });
    expect(parseArgs(["-h"])).toEqual({ mode: { kind: "help" } });
  });

  it("interleaves flags and positionals", () => {
    expect(parseArgs(["--stateless", "tell", "me", "--ephemeral", "a joke"])).toEqual({
      mode: {
        kind: "one-shot",
        prompt: "tell me a joke",
        stateless: true,
        ephemeral: true,
      },
    });
  });

  it("throws on an unknown flag", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown flag/);
  });

  it("ignores a standalone -- separator (forwarded by pnpm)", () => {
    expect(parseArgs(["--", "--stateless", "hello"])).toEqual({
      mode: {
        kind: "one-shot",
        prompt: "hello",
        stateless: true,
        ephemeral: false,
      },
    });
  });

  it("daemon subcommand defaults to run", () => {
    expect(parseArgs(["daemon"])).toEqual({ mode: { kind: "daemon", action: "run" } });
    expect(parseArgs(["daemon", "start"])).toEqual({ mode: { kind: "daemon", action: "start" } });
    expect(parseArgs(["daemon", "stop"])).toEqual({ mode: { kind: "daemon", action: "stop" } });
    expect(parseArgs(["daemon", "status"])).toEqual({ mode: { kind: "daemon", action: "status" } });
  });

  it("chat subcommand picks up --channel", () => {
    expect(parseArgs(["chat"])).toEqual({ mode: { kind: "chat", channel: "cli" } });
    expect(parseArgs(["chat", "--channel", "telegram:42"])).toEqual({
      mode: { kind: "chat", channel: "telegram:42" },
    });
  });

  it("install requires a known target", () => {
    expect(parseArgs(["install", "launchd"])).toEqual({
      mode: { kind: "install", target: "launchd" },
    });
    expect(parseArgs(["install", "systemd"])).toEqual({
      mode: { kind: "install", target: "systemd" },
    });
    expect(() => parseArgs(["install"])).toThrow(/install requires/);
    expect(() => parseArgs(["install", "xyz"])).toThrow(/install requires/);
  });
});
