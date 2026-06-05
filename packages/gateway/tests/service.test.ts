import { describe, expect, it } from "vitest";
import { launchdPlist, systemdUnit } from "../src/service.ts";

describe("service templates", () => {
  it("launchdPlist embeds ProgramArguments and StandardOut/Err paths", () => {
    const d = launchdPlist(
      { exec: "/usr/local/bin/miniclaw", home: "/Users/me/.miniclaw" },
      "/Users/me",
    );
    expect(d.destPath).toContain("Library/LaunchAgents/com.miniclaw.gateway.plist");
    expect(d.contents).toContain("<string>/usr/local/bin/miniclaw</string>");
    expect(d.contents).toContain("<string>daemon</string>");
    expect(d.contents).toContain("<string>run</string>");
    expect(d.contents).toContain("/Users/me/.miniclaw/daemon.out.log");
  });

  it("launchdPlist escapes XML entities in env values", () => {
    const d = launchdPlist(
      {
        exec: "/bin/miniclaw",
        home: "/h",
        env: { TOKEN: "a<b&c\"d" },
      },
      "/u",
    );
    expect(d.contents).toContain("a&lt;b&amp;c&quot;d");
  });

  it("systemdUnit composes ExecStart with quoted args", () => {
    const d = systemdUnit(
      { exec: "/usr/bin/miniclaw", home: "/home/me/.miniclaw" },
      "/home/me",
    );
    expect(d.destPath).toContain(".config/systemd/user/miniclaw-gateway.service");
    expect(d.contents).toContain("ExecStart=/usr/bin/miniclaw daemon run");
    expect(d.contents).toContain("WorkingDirectory=/home/me/.miniclaw");
    expect(d.contents).toContain("Restart=on-failure");
  });
});
