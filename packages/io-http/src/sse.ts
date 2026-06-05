/**
 * Tiny Server-Sent-Events writer. The SSE wire format is just:
 *
 *   event: <name>\n
 *   data: <payload>\n
 *   \n   ← blank line separates frames
 *
 * Payloads may be multi-line; we re-prefix each line with `data: ` so a
 * JSON.stringify result that contains `\n` (rare but legal in some
 * structured fields) parses cleanly on the EventSource side.
 *
 * SseSink is sink-shaped (just a `write` + `end`) rather than HTTP-coupled
 * so tests can drive it with a string buffer.
 */
export interface SseSink {
  write(chunk: string): void;
  end(): void;
}

export class SseWriter {
  constructor(private readonly sink: SseSink) {}

  /** Write one named SSE event with a JSON-encoded data payload. */
  event(name: string, payload: unknown): void {
    const json = JSON.stringify(payload ?? null);
    const lines = json.split("\n").map((l) => `data: ${l}`).join("\n");
    this.sink.write(`event: ${name}\n${lines}\n\n`);
  }

  /** Send the standard SSE heartbeat (`:` comment frame). Use sparingly. */
  ping(): void {
    this.sink.write(`: ping\n\n`);
  }

  close(): void {
    this.sink.end();
  }
}
