import { existsSync } from "node:fs";
import { defaultSocketPath, socketAttachIO } from "@miniclaw/gateway";

export async function runChat(channel: string): Promise<void> {
  const socketPath = defaultSocketPath();
  if (!existsSync(socketPath)) {
    process.stderr.write(
      `no daemon at ${socketPath}. Start one with: miniclaw daemon start\n`,
    );
    process.exit(1);
  }
  await socketAttachIO({
    socketPath,
    channel,
    banner: `attached to daemon on ${socketPath}, channel=${channel}\ntype /exit to detach\n`,
  });
}
