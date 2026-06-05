// Transport-agnostic I/O contract for the harness. Implementations live in
// the consumer (CLI uses node:readline; tests use a scripted fake; a future
// HTTP server would use sockets). Keeping this minimal makes it cheap to
// add another front-end without touching the loop.

export interface IOAdapter {
  /**
   * Read one line of input from the user. Returns null on EOF / disconnect,
   * which the harness treats as a signal to stop the loop cleanly.
   */
  readLine(prompt: string): Promise<string | null>;

  /** Write a chunk of text. The harness appends its own newlines as needed. */
  write(text: string): void;

  /** Optional: notified each time the agent invokes a tool. CLI uses it to
   * print "· tool foo(...)"; HTTP could stream it as an SSE event. */
  onToolCall?(name: string, args: unknown): void;

  /**
   * Optional: receive assistant token deltas as the provider streams them.
   * When implemented, the harness wires it through to runTurn and suppresses
   * its own end-of-turn write of trace.finalText — the adapter is expected
   * to render incrementally. Providers without streaming support never
   * trigger this, so a streaming adapter still works against them (it just
   * won't see anything until the harness's fallback final write… which is
   * exactly what an HTTP/SSE adapter should override end-to-end).
   */
  onAssistantToken?(delta: string): void;

  /**
   * Optional: ask the user to confirm a sensitive action. Returns true to
   * proceed, false to deny. If the adapter doesn't implement this, the
   * agent fails closed on any skill where requiresConfirmation === true.
   */
  confirm?(prompt: string): Promise<boolean>;

  /** Release any underlying resources (close readline, sockets, etc.). */
  close(): void;
}
