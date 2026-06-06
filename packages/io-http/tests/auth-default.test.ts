import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AssistantTurn,
  type LLMProvider,
  SkillRegistry,
} from "@miniclaw/core";
import { Agent } from "@miniclaw/agent";
import { createHttpServer } from "../src/index.ts";

class FakeLLM implements LLMProvider {
  async chat() {
    return { kind: "final" as const, text: "ok" } as AssistantTurn;
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
  // Silence the generated-token log in test output
  const origWrite = process.stderr.write;
  process.stderr.write = (() => true) as any;
  const server = createHttpServer({ agent, bearerToken: opts.bearerToken });
  process.stderr.write = origWrite;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// VULN-10: HTTP server auth default
describe("createHttpServer — auth is always enforced (VULN-10)", () => {
  let running: RunningServer | undefined;

  afterEach(async () => {
    if (running) {
      await running.close();
      running = undefined;
    }
  });

  it("rejects unauthenticated requests even when no bearerToken is configured", async () => {
    running = await start(buildAgent(new FakeLLM()));
    const res = await fetch(`${running.url}/healthz`);
    // Server should auto-generate a token, so unauthenticated requests fail
    expect(res.status).toBe(401);
  });

  it("allows requests with the explicit bearerToken", async () => {
    running = await start(buildAgent(new FakeLLM()), { bearerToken: "my-secret" });
    const res = await fetch(`${running.url}/healthz`, {
      headers: { authorization: "Bearer my-secret" },
    });
    expect(res.status).toBe(200);
  });
});
