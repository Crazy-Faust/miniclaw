import { describe, expect, it } from "vitest";
import { checkShellCall } from "../src/security.ts";

describe("checkShellCall", () => {
  it("accepts an allowlisted bin with safe args", () => {
    const r = checkShellCall("ls", ["-la", "/tmp"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bin).toBe("ls");
      expect(r.args).toEqual(["-la", "/tmp"]);
    }
  });

  it("rejects bins not on the allowlist", () => {
    expect(checkShellCall("rm", ["-rf", "/"]).ok).toBe(false);
  });

  it("rejects bin containing a separator", () => {
    expect(checkShellCall("ls; rm x", []).ok).toBe(false);
    expect(checkShellCall("/bin/ls", []).ok).toBe(false);
  });

  it("rejects args with shell metacharacters", () => {
    expect(checkShellCall("ls", ["$(whoami)"]).ok).toBe(false);
    expect(checkShellCall("echo", ["a && b"]).ok).toBe(false);
    expect(checkShellCall("echo", ["`id`"]).ok).toBe(false);
  });

  it("rejects non-string args", () => {
    expect(checkShellCall("ls", [123]).ok).toBe(false);
    expect(checkShellCall("ls", "/tmp" as unknown as string[]).ok).toBe(false);
  });
});
