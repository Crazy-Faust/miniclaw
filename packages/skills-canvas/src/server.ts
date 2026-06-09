import type { IncomingMessage, ServerResponse } from "node:http";
import type { CanvasStore } from "./store.ts";

const PAGE_TEMPLATE = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 15px system-ui, sans-serif; max-width: 860px; margin: 32px auto; padding: 0 16px; line-height: 1.5; }
  h1 { font-size: 22px; }
  pre { background: #f5f5f5; padding: 12px; border-radius: 6px; overflow-x: auto; }
  code { font: 13px/1.4 ui-monospace, Menlo, Consolas, monospace; }
</style>
</head>
<body>
${body}
</body>
</html>`;

/**
 * Plug into a node:http server. Returns true if the request was handled
 * (so the caller can fall through to other routes when it returns false).
 *
 * Routes:
 *   GET /canvas              -> list page with links to each canvas
 *   GET /canvas/:id          -> the rendered HTML of one canvas
 *   GET /canvas/:id.json     -> raw record as JSON
 */
export function handleCanvasRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: CanvasStore,
): boolean {
  if (req.method !== "GET" || !req.url) return false;
  const url = req.url.split("?")[0]!;

  if (url === "/canvas" || url === "/canvas/") {
    const items = store.list();
    const body = items.length === 0
      ? "<h1>canvas</h1><p>(no canvases yet)</p>"
      : `<h1>canvas</h1><ul>${items
          .map(
            (c) =>
              `<li><a href="/canvas/${encodeURIComponent(c.id)}">${escapeHtml(c.title)}</a>` +
              ` <small>updated ${new Date(c.updatedAt).toISOString()}</small></li>`,
          )
          .join("")}</ul>`;
    sendHtml(res, 200, PAGE_TEMPLATE("canvas", body));
    return true;
  }

  const jsonMatch = /^\/canvas\/([^/]+)\.json$/.exec(url);
  if (jsonMatch) {
    const rec = store.get(decodeURIComponent(jsonMatch[1]!));
    if (!rec) {
      sendJson(res, 404, { error: "canvas not found" });
      return true;
    }
    sendJson(res, 200, rec);
    return true;
  }

  const idMatch = /^\/canvas\/([^/]+)$/.exec(url);
  if (idMatch) {
    const rec = store.get(decodeURIComponent(idMatch[1]!));
    if (!rec) {
      sendHtml(res, 404, PAGE_TEMPLATE("not found", "<h1>not found</h1>"));
      return true;
    }
    // The agent owns the body — we only frame it. Untrusted HTML coming
    // from the model is the documented contract; the user explicitly
    // opens these pages.
    // VULN-17: Serve with CSP sandbox to prevent script execution.
    sendSandboxedHtml(res, 200, PAGE_TEMPLATE(rec.title, rec.html));
    return true;
  }

  return false;
}

/**
 * Security headers applied to canvas pages that render LLM-generated HTML.
 * VULN-17: Content-Security-Policy: sandbox prevents script execution.
 */
const CANVAS_SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: https:;",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function sendSandboxedHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    ...CANVAS_SECURITY_HEADERS,
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
