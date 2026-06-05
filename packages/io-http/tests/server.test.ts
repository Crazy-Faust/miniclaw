import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AssistantTurn,
  type LLMProvider,
  SkillRegistry,
} from "@miniclaw/core";
import { Agent } from "@miniclaw/agent";
import { createHttpServer } from "../src/index.ts";

class StreamingLLM implements LLMProvider {
  private idx = 0;
  constructor(private readonly script: Array<{ chunks: string[]; turn: AssistantTurn }>) {}
  async chat(opts: { onToken?: (delta: string) => void }) {
    const step = this.script[this.idx++];
    if (!step) throw new Error("ran out of script");
    if (opts.onToken) for (const c of step.chunks) opts.onToken(c);
    return step.turn;
  }
}

function noOpDeps() {
  const memory = { add: () => 0, search: () => [], listRecent: () => [] };
  const audit = { logToolCall: () => {} };
  const context = {
    prepare: (m: string) => ({ system: "", messages: [{ role: "user" as const, content: m }] }),
    recordUser: () => {},
    recordAssistant: () => {},
  };
  return { memory, audit, context };
}

function buildAgent(llm: LLMProvider) {
  const { memory, audit, context } = noOpDeps();
  return new Agent({
    llm, registry: new SkillRegistry(), context, memory, audit, dbPath: ":memory:",
  });
}

interface RunningServer {
  url: string;
  close(): Promise<void>;
}

async function start(agent: Agent, opts: { bearerToken?: string } = {}): Promise<RunningServer> {
  const server = createHttpServer({ agent, bearerToken: opts.bearerToken });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface ParsedEvent { event: string; data: unknown }

async function readAllSse(res: Response): Promise<ParsedEvent[]> {
  const reader = res.body?.getReader();
  if (!reader) return [];
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  const frames = buf.split("\n\n").filter(Boolean);
  return frames.map((f) => {
    const lines = f.split("\n");
    const ev = lines.find((l) => l.startsWith("event: "))!.slice("event: ".length);
    const dataLines = lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice("data: ".length));
    return { event: ev, data: JSON.parse(dataLines.join("\n")) };
  });
}

describe("createHttpServer — wire-level integration", () => {
  let running: RunningServer | undefined;

  afterEach(async () => {
    if (running) {
      await running.close();
      running = undefined;
    }
  });

  it("GET /healthz returns plain text 'ok'", async () => {
    running = await start(buildAgent(new StreamingLLM([])));
    const res = await fetch(`${running.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("POST /chat streams SSE events and ends after the final frame", async () => {
    const agent = buildAgent(new StreamingLLM([
      { chunks: ["Hel", "lo"], turn: { kind: "final", text: "Hello" } },
    ]));
    running = await start(agent);
    const res = await fetch(`${running.url}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const events = await readAllSse(res);
    const types = events.map((e) => e.event);
    expect(types).toEqual(["token", "token", "final"]);
    expect((events.at(-1)!.data as { text: string }).text).toBe("Hello");
  });

  it("POST /chat with malformed JSON returns 400", async () => {
    running = await start(buildAgent(new StreamingLLM([])));
    const res = await fetch(`${running.url}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{this is not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid JSON/);
  });

  it("POST /chat with empty message returns 400", async () => {
    running = await start(buildAgent(new StreamingLLM([])));
    const res = await fetch(`${running.url}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("unknown routes return 404", async () => {
    running = await start(buildAgent(new StreamingLLM([])));
    const res = await fetch(`${running.url}/nope`);
    expect(res.status).toBe(404);
  });

  it("bearerToken: refuses requests without a matching Authorization header (401)", async () => {
    running = await start(buildAgent(new StreamingLLM([])), { bearerToken: "secret" });
    const noAuth = await fetch(`${running.url}/healthz`);
    expect(noAuth.status).toBe(401);
    const wrong = await fetch(`${running.url}/healthz`, {
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(wrong.status).toBe(401);
    const right = await fetch(`${running.url}/healthz`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(right.status).toBe(200);
  });
});
