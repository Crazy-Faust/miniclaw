import { socketAttachIO } from "@miniclaw/gateway";

import { ensureDaemon } from "./ensure-daemon.ts";

export interface RunClientOpts {
  /** Conversation channel to attach to. */
  channel: string;
  /** Start a fresh session instead of resuming the channel's active one. */
  fresh: boolean;
  /** Non-interactive: run this single prompt, print the answer, then detach. */
  oneShot?: string;
}

/**
 * Ensure a daemon is running, then attach to it as a client. This is the
 * single entry path for `miniclaw` (repl), `miniclaw "prompt"` (one-shot),
 * and `miniclaw chat`; they differ only in channel / fresh / oneShot.
 */
export async function runClient(opts: RunClientOpts): Promise<void> {
  const socketPath = await ensureDaemon();
  await socketAttachIO({
    socketPath,
    channel: opts.channel,
    fresh: opts.fresh,
    oneShot: opts.oneShot,
    banner: opts.oneShot === undefined
      ? `attached to daemon on ${socketPath}, channel=${opts.channel}\ntype /help for slash commands, /exit to detach\n`
      : undefined,
  });
}
