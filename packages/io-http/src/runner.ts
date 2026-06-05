import type { Agent } from "@miniclaw/agent";
import { SseWriter, type SseSink } from "./sse.ts";

/**
 * Run one agent turn and stream every interesting hook event to an SSE sink.
 * Used by the HTTP server (POST /chat) and exposed directly so other
 * transports (WebSocket, Workers, etc.) can reuse the same wire format.
 *
 * Event names sent to the sink:
 *   - `token`      — { delta }     incremental assistant text
 *   - `tool_call`  — { name, args } each tool call dispatched by the agent
 *   - `tool_result`— { name, ok, output } observed after the tool runs
 *   - `final`      — { text }      complete assistant answer for the turn
 *   - `error`      — { message }   the agent or provider threw
 *
 * The function resolves once the turn is complete and the SSE stream is
 * closed; it never throws — errors are emitted as the final event so the
 * client always gets a clean stream termination.
 */
export async function streamTurn(
  agent: Agent,
  userMsg: string,
  sink: SseSink,
): Promise<void> {
  const sse = new SseWriter(sink);
  try {
    const trace = await agent.runTurn(userMsg, {
      onAssistantToken: (delta) => sse.event("token", { delta }),
      onIntermediateText: (text) => sse.event("token", { delta: text }),
      onTool: (name, args) => sse.event("tool_call", { name, args }),
      onPostToolUse: (call, result) =>
        sse.event("tool_result", { name: call.name, ok: result.ok, output: result.output }),
    });
    sse.event("final", { text: trace.finalText });
  } catch (err) {
    sse.event("error", { message: (err as Error).message });
  } finally {
    sse.close();
  }
}
