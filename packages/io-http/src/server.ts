import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Agent } from "@miniclaw/agent";
import { streamTurn } from "./runner.ts";

export interface HttpServerOpts {
  agent: Agent;
  /**
   * Bearer-token check. If not provided, a random token is generated and
   * logged to stderr so the operator can use it. This fail-closed default
   * prevents accidentally exposing the agent without authentication.
   *
   * VULN-10: Changed from optional-skip to optional-generate.
   */
  bearerToken?: string;
}

/**
 * Stand up a thin HTTP server that fronts an Agent via SSE. Two endpoints:
 *
 *   POST /chat       JSON body { "message": "..." } -> SSE stream of
 *                    token/tool_call/tool_result/final/error events.
 *   GET  /healthz    plain text "ok".
 *
 * Everything else 404s. This is intentionally small: no session management,
 * no JSON-RPC. The package is meant as a starting point for production use,
 * not as a finished product.
 *
 * Auth is always on: if no bearerToken is supplied, a random one is
 * generated and printed to stderr.
 */
export function createHttpServer(opts: HttpServerOpts): Server {
  const token = opts.bearerToken ?? generateToken();
  if (!opts.bearerToken) {
    process.stderr.write(
      `[io-http] no bearerToken provided — generated token: ${token}\n` +
      `[io-http] use Authorization: Bearer ${token}\n`,
    );
  }
  const resolvedOpts = { ...opts, bearerToken: token };
  const server = createServer((req, res) => handleRequest(req, res, resolvedOpts));
  return server;
}

/** CORS headers to prevent browser-based cross-origin attacks. VULN-10. */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "null",
  "access-control-allow-methods": "POST, GET",
  "access-control-allow-headers": "authorization, content-type",
};

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: HttpServerOpts & { bearerToken: string },
): Promise<void> {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (!isAuthorized(req, opts.bearerToken)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain", ...CORS_HEADERS });
    res.end("ok");
    return;
  }

  if (req.method === "POST" && req.url === "/chat") {
    await handleChat(req, res, opts.agent);
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  agent: Agent,
): Promise<void> {
  let body: { message?: unknown };
  try {
    body = await readJson(req);
  } catch (err) {
    sendJson(res, 400, { error: `invalid JSON: ${(err as Error).message}` });
    return;
  }
  if (typeof body.message !== "string" || body.message.length === 0) {
    sendJson(res, 400, { error: "'message' must be a non-empty string" });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...CORS_HEADERS,
  });

  await streamTurn(agent, body.message, {
    write: (chunk) => res.write(chunk),
    end: () => res.end(),
  });
}

function isAuthorized(req: IncomingMessage, expected: string): boolean {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return false;
  if (!header.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length) === expected;
}

async function readJson(req: IncomingMessage): Promise<{ message?: unknown }> {
  const MAX_BYTES = 64 * 1024;
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        req.destroy();
        reject(new Error(`request body exceeds ${MAX_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

function generateToken(): string {
  return randomBytes(24).toString("base64url");
}
