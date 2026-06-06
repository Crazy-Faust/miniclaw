import { z } from "zod";
import { ok, fail, type Skill } from "@miniclaw/core";
import type { Gateway } from "@miniclaw/gateway";

/**
 * Build the four sessions_* skills bound to a single Gateway. The CLI
 * wires the same Gateway into the gateway daemon and into this skill
 * registry so the agent sees a coherent view of running sessions.
 */
export function createSessionsSkills(gateway: Gateway): Skill<unknown>[] {
  const ListParams = z.object({
    limit: z.number().int().min(1).max(200).default(20),
  });
  const list: Skill<z.infer<typeof ListParams>> = {
    name: "sessions_list",
    description:
      "List recent or active sessions the gateway is supervising. Returns one line " +
      "per session with id, channel, status, and last-activity timestamp.",
    parameters: ListParams,
    execute(args) {
      const rows = gateway.list(args.limit);
      if (rows.length === 0) return ok("(no sessions)");
      const lines = rows.map(
        (s) =>
          `#${s.id}  channel=${s.channel}  status=${s.status}  last=${new Date(
            s.lastActivityAt,
          ).toISOString()}`,
      );
      return ok(lines.join("\n"));
    },
  };

  const HistoryParams = z.object({
    sessionId: z.string().min(1),
    limit: z.number().int().min(1).max(200).default(20),
  });
  const history: Skill<z.infer<typeof HistoryParams>> = {
    name: "sessions_history",
    description:
      "Show the recent messages in a specific session. Useful before sending " +
      "a follow-up so you can see what the user and agent already discussed.",
    parameters: HistoryParams,
    execute(args) {
      const rows = gateway.history(args.sessionId, args.limit);
      if (rows.length === 0) return ok("(empty)");
      const lines = rows.map((m) => `[${m.role}] ${m.content}`);
      return ok(lines.join("\n"));
    },
  };

  const SendParams = z.object({
    sessionId: z.string().min(1),
    message: z.string().min(1),
  });
  const send: Skill<z.infer<typeof SendParams>> = {
    name: "sessions_send",
    description:
      "Send a message to another session as if you were that channel's user. " +
      "Use this to coordinate with a long-running agent on a different channel; the " +
      "remote session runs one turn and returns its final answer. " +
      "The calling session and target session must share the same channel prefix " +
      "(e.g. both 'cli' or both 'discord:dm:...').",
    parameters: SendParams,
    async execute(args, ctx) {
      const rec = gateway.list(500).find((s) => s.id === args.sessionId);
      if (!rec) return fail(`unknown session: ${args.sessionId}`);
      // VULN-14: Ownership check — the calling session and target session
      // must share the same channel (or at minimum the same transport prefix).
      // In single-user CLI mode, ctx.channel is typically undefined so we
      // allow the call (backward-compat). In multi-user daemon mode,
      // ctx.channel is set by the transport.
      const callerChannel = ctx.channel;
      if (callerChannel && rec.channel !== callerChannel) {
        return fail(
          `refused: session ${args.sessionId} belongs to channel '${rec.channel}', ` +
          `but you are on channel '${callerChannel}'`,
        );
      }
      const session = gateway.attach(rec.channel);
      const trace = await session.send(args.message);
      return ok(trace.finalText);
    },
  };

  const SpawnParams = z.object({
    channel: z
      .string()
      .min(1)
      .describe("Logical channel identifier (e.g. 'cli', 'telegram:42')."),
    agent: z.string().default("default"),
  });
  const spawn: Skill<z.infer<typeof SpawnParams>> = {
    name: "sessions_spawn",
    description:
      "Start a brand-new session on a channel — ends any existing active session " +
      "for that channel first. Returns the new session id so subsequent " +
      "sessions_send calls can target it.",
    parameters: SpawnParams,
    execute(args) {
      const session = gateway.spawn(args.channel, args.agent);
      return ok(
        `created session ${session.record.id} on channel ${session.record.channel}`,
      );
    },
  };

  return [list, history, send, spawn] as Skill<unknown>[];
}
