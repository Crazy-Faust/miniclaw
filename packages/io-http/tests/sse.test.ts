import { describe, expect, it } from "vitest";
import { SseWriter, type SseSink } from "../src/index.ts";

function bufferSink() {
  let buf = "";
  let closed = false;
  const sink: SseSink = {
    write: (c: string) => { buf += c; },
    end: () => { closed = true; },
  };
  return { sink, get buf() { return buf; }, get closed() { return closed; } };
}

describe("SseWriter", () => {
  it("emits a well-formed SSE frame: event + JSON data + blank line", () => {
    const b = bufferSink();
    new SseWriter(b.sink).event("token", { delta: "hi" });
    expect(b.buf).toBe(`event: token\ndata: {"delta":"hi"}\n\n`);
  });

  it("prefixes every line of a multi-line payload with 'data: '", () => {
    const b = bufferSink();
    // Force a payload whose JSON encoding contains a literal newline.
    new SseWriter(b.sink).event("note", "first\nsecond");
    expect(b.buf).toBe(`event: note\ndata: "first\\nsecond"\n\n`);
  });

  it("encodes null payloads as JSON null", () => {
    const b = bufferSink();
    new SseWriter(b.sink).event("ping", undefined);
    expect(b.buf).toBe(`event: ping\ndata: null\n\n`);
  });

  it("ping() emits a comment-line heartbeat", () => {
    const b = bufferSink();
    new SseWriter(b.sink).ping();
    expect(b.buf).toBe(`: ping\n\n`);
  });

  it("close() ends the underlying sink", () => {
    const b = bufferSink();
    const w = new SseWriter(b.sink);
    w.close();
    expect(b.closed).toBe(true);
  });
});
