// Service-install file generators. Pure-string functions — the CLI
// writes the result to disk and prints next steps; no privileged actions
// happen here.
//
// We support two install targets:
//   - launchd (macOS):  ~/Library/LaunchAgents/com.miniclaw.gateway.plist
//   - systemd user:     ~/.config/systemd/user/miniclaw-gateway.service

export interface ServiceTemplateInput {
  /** Absolute path to a runnable miniclaw entrypoint. */
  exec: string;
  /** Arguments after `exec`. Defaults to ["daemon", "run"]. */
  args?: string[];
  /** Absolute path to the directory holding the SQLite db etc. */
  home: string;
  /** Env vars to set in the service environment. */
  env?: Record<string, string>;
}

export interface ServiceDescriptor {
  /** Where to install the file. The CLI writes it on the user's request. */
  destPath: string;
  /** File contents. */
  contents: string;
  /** Human-readable instructions printed after the file is written. */
  instructions: string;
}

export function launchdPlist(input: ServiceTemplateInput, homeDir: string): ServiceDescriptor {
  const args = input.args ?? ["daemon", "run"];
  const programArgs = [input.exec, ...args]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  const envBlock = input.env && Object.keys(input.env).length > 0
    ? "  <key>EnvironmentVariables</key>\n  <dict>\n" +
      Object.entries(input.env)
        .map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`)
        .join("\n") +
      "\n  </dict>\n"
    : "";
  const stdoutPath = `${input.home}/daemon.out.log`;
  const stderrPath = `${input.home}/daemon.err.log`;

  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.miniclaw.gateway</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(input.home)}</string>
${envBlock}  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
  const destPath = `${homeDir}/Library/LaunchAgents/com.miniclaw.gateway.plist`;
  const instructions = `Wrote ${destPath}.
Load it with:
  launchctl load -w ${destPath}
Stop it with:
  launchctl unload -w ${destPath}
Daemon stdout/stderr land in ${stdoutPath} / ${stderrPath}.`;
  return { destPath, contents, instructions };
}

export function systemdUnit(input: ServiceTemplateInput, homeDir: string): ServiceDescriptor {
  const args = input.args ?? ["daemon", "run"];
  const execStart = [input.exec, ...args].map(quoteShell).join(" ");
  const envLines = input.env
    ? Object.entries(input.env).map(([k, v]) => `Environment=${k}=${quoteShell(v)}`).join("\n")
    : "";

  const contents = `[Unit]
Description=miniclaw gateway daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=${input.home}
ExecStart=${execStart}
Restart=on-failure
${envLines}

[Install]
WantedBy=default.target
`;
  const destPath = `${homeDir}/.config/systemd/user/miniclaw-gateway.service`;
  const instructions = `Wrote ${destPath}.
Enable and start it with:
  systemctl --user daemon-reload
  systemctl --user enable --now miniclaw-gateway
Stop with:
  systemctl --user stop miniclaw-gateway
Logs:
  journalctl --user -u miniclaw-gateway -f`;
  return { destPath, contents, instructions };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function quoteShell(s: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}
