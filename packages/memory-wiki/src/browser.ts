import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { WikiPageRecord, WikiStore } from "@miniclaw/core";

type PageListRecord = Pick<WikiPageRecord, "path" | "folder" | "title" | "tags">;

interface LLMUsagePageReader {
  readLLMUsageWikiPage(): WikiPageRecord;
}

export interface WikiBrowserOpts {
  wiki: WikiStore;
  host?: string;
  port?: number;
  token?: string;
}

export interface WikiBrowserHandle {
  server: Server;
  url: string;
  token: string;
  stop(): Promise<void>;
}

export async function startWikiBrowserServer(opts: WikiBrowserOpts): Promise<WikiBrowserHandle> {
  const host = opts.host ?? "127.0.0.1";
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const server = createServer((req, res) => handleWikiBrowserRequest(req, res, opts.wiki, token));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const url = `http://${formatHostForUrl(host)}:${address.port}/?token=${encodeURIComponent(token)}`;
  return {
    server,
    url,
    token,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function handleWikiBrowserRequest(
  req: IncomingMessage,
  res: ServerResponse,
  wiki: WikiStore,
  token: string,
): void {
  if (req.method !== "GET" || !req.url) {
    sendText(res, 405, "method not allowed");
    return;
  }
  const url = new URL(req.url, "http://127.0.0.1");
  if (!isAuthorized(req, url, token)) {
    sendText(res, 401, "unauthorized");
    return;
  }

  if (url.pathname === "/" || url.pathname === "/wiki") {
    sendHtml(res, 200, page("LLM Wiki", renderIndex(wiki, token)));
    return;
  }
  if (url.pathname === "/search") {
    const q = url.searchParams.get("q") ?? "";
    sendHtml(res, 200, page(`Search: ${q}`, renderSearch(wiki, token, q)));
    return;
  }
  if (url.pathname === "/usage") {
    const usagePage = readLLMUsagePage(wiki);
    if (!usagePage) {
      sendHtml(res, 404, page("LLM Usage unavailable", "<h1>LLM Usage unavailable</h1>"));
      return;
    }
    sendHtml(res, 200, page("LLM Usage", renderUsagePage(usagePage, token)));
    return;
  }
  if (url.pathname === "/folder") {
    const folderPath = url.searchParams.get("path") ?? "";
    const folders = wiki.listWikiFolders();
    const folder = folders.find((f) => f.path === folderPath) ?? null;
    const pages = folderPath ? wiki.listWikiPages(folderPath, 500) : [];
    if (!folderPath || (!folder && pages.length === 0)) {
      sendHtml(res, 404, page("Folder not found", `<h1>Folder not found</h1><p>${escapeHtml(folderPath)}</p>`));
      return;
    }
    sendHtml(res, 200, page(`Folder: ${folderPath}`, renderFolder(folderPath, folder?.title ?? folderPath, pages, token)));
    return;
  }
  if (url.pathname === "/tag") {
    const tag = url.searchParams.get("tag") ?? "";
    const pages = tag ? filterPagesByTag(wiki.listWikiPages(undefined, 500), tag) : [];
    if (!tag || pages.length === 0) {
      sendHtml(res, 404, page("Tag not found", `<h1>Tag not found</h1><p>${escapeHtml(tag)}</p>`));
      return;
    }
    sendHtml(res, 200, page(`Tag: ${tag}`, renderTag(tag, pages, token)));
    return;
  }
  if (url.pathname === "/page") {
    const path = url.searchParams.get("path") ?? "";
    const rec = path ? wiki.readWikiPage(path) : null;
    if (!rec) {
      sendHtml(res, 404, page("Not found", `<h1>Not found</h1><p>${escapeHtml(path)}</p>`));
      return;
    }
    sendHtml(res, 200, page(rec.title, renderPage(rec, token)));
    return;
  }
  if (url.pathname === "/api/pages") {
    const folder = url.searchParams.get("folder") ?? undefined;
    const tag = url.searchParams.get("tag") ?? undefined;
    const pages = wiki.listWikiPages(folder, 500);
    sendJson(res, 200, tag ? filterPagesByTag(pages, tag) : pages);
    return;
  }
  if (url.pathname === "/api/page") {
    const path = url.searchParams.get("path") ?? "";
    const rec = path ? wiki.readWikiPage(path) : null;
    if (!rec) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    sendJson(res, 200, rec);
    return;
  }
  if (url.pathname === "/api/usage") {
    const usagePage = readLLMUsagePage(wiki);
    if (!usagePage) {
      sendJson(res, 404, { error: "not available" });
      return;
    }
    sendJson(res, 200, usagePage);
    return;
  }

  sendText(res, 404, "not found");
}

function renderIndex(wiki: WikiStore, token: string): string {
  const folders = wiki.listWikiFolders();
  const allPages = wiki.listWikiPages(undefined, 500);
  const pages = allPages.slice(0, 200);
  const tags = collectTagCounts(allPages);
  return `
    <header>
      <h1>LLM Wiki</h1>
      <form action="/search" method="get">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <input name="q" placeholder="Search wiki pages" autofocus>
        <button>Search</button>
      </form>
    </header>
    <section>
      <h2>Folders</h2>
      ${folders.length === 0 ? "<p class=\"muted\">No folders yet.</p>" : renderFolderList(folders, token)}
    </section>
    <section>
      <h2>Tags</h2>
      ${tags.length === 0 ? "<p class=\"muted\">No tags yet.</p>" : renderTagList(tags, token)}
    </section>
    ${hasLLMUsagePage(wiki) ? `
      <section>
        <h2>System</h2>
        <ul class="system-links">
          <li><a href="${href(`/usage?token=${encodeURIComponent(token)}`)}">LLM Usage</a> <span class="muted">user-only statistics</span></li>
        </ul>
      </section>
    ` : ""}
    <section>
      <h2>Pages</h2>
      ${pages.length === 0 ? "<p class=\"muted\">No wiki pages yet. Write memories, then run /wiki_maintain.</p>" : renderPageList(pages, token)}
    </section>
  `;
}

function renderUsagePage(rec: WikiPageRecord, token: string): string {
  return `
    <p><a href="${href(`/?token=${encodeURIComponent(token)}`)}">← index</a></p>
    <article>
      <h1>${escapeHtml(rec.title)}</h1>
      <dl>
        <dt>Path</dt><dd><code>${escapeHtml(rec.path)}</code></dd>
        <dt>Updated</dt><dd>${new Date(rec.updatedAt).toISOString()}</dd>
      </dl>
      ${renderUsageContent(rec.content)}
    </article>
  `;
}

function renderUsageContent(content: string): string {
  const lines = content.split(/\r?\n/);
  const parts: string[] = [];
  let plain: string[] = [];

  const flushPlain = (): void => {
    const text = plain.join("\n").trimEnd();
    plain = [];
    if (text.trim()) parts.push(`<pre>${escapeHtml(text)}</pre>`);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const headers = parseMarkdownTableRow(lines[i] ?? "");
    const separator = parseMarkdownTableRow(lines[i + 1] ?? "");
    if (headers.length > 0 && isMarkdownTableSeparator(separator, headers.length)) {
      flushPlain();
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length) {
        const row = parseMarkdownTableRow(lines[i] ?? "");
        if (row.length === 0) break;
        rows.push(normalizeTableRow(row, headers.length));
        i += 1;
      }
      i -= 1;
      parts.push(renderHtmlTable(headers, rows));
      continue;
    }
    plain.push(lines[i] ?? "");
  }

  flushPlain();
  return parts.length ? parts.join("\n") : "<p class=\"muted\">No usage data yet.</p>";
}

function parseMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : [];
}

function isMarkdownTableSeparator(cells: string[], headerCount: number): boolean {
  if (cells.length !== headerCount) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function normalizeTableRow(row: string[], cellCount: number): string[] {
  if (row.length === cellCount) return row;
  return [...row, ...Array(Math.max(0, cellCount - row.length)).fill("")].slice(0, cellCount);
}

function renderHtmlTable(headers: string[], rows: string[][]): string {
  return `<div class="usage-table-wrap"><table class="usage-table"><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function renderFolder(
  folderPath: string,
  folderTitle: string,
  pages: PageListRecord[],
  token: string,
): string {
  return `
    <p><a href="${href(`/?token=${encodeURIComponent(token)}`)}">← index</a></p>
    <h1>${escapeHtml(folderTitle)}</h1>
    <p><code>${escapeHtml(folderPath)}</code></p>
    <section>
      <h2>Pages</h2>
      ${pages.length === 0 ? "<p class=\"muted\">No pages in this folder yet.</p>" : renderPageList(pages, token)}
    </section>
  `;
}

function renderTag(tag: string, pages: PageListRecord[], token: string): string {
  return `
    <p><a href="${href(`/?token=${encodeURIComponent(token)}`)}">← index</a></p>
    <h1>Tag: ${escapeHtml(tag)}</h1>
    <section>
      <h2>Pages</h2>
      ${renderPageList(pages, token)}
    </section>
  `;
}

function renderSearch(wiki: WikiStore, token: string, q: string): string {
  const hits = q.trim() ? wiki.searchWiki(q, 50) : [];
  return `
    <p><a href="${href(`/?token=${encodeURIComponent(token)}`)}">← index</a></p>
    <h1>Search</h1>
    <form action="/search" method="get">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <input name="q" value="${escapeHtml(q)}" placeholder="Search wiki pages">
      <button>Search</button>
    </form>
    ${q.trim() && hits.length === 0 ? "<p class=\"muted\">No matches.</p>" : ""}
    ${renderPageList(hits, token)}
  `;
}

function renderPage(rec: WikiPageRecord, token: string): string {
  return `
    <p><a href="${href(`/?token=${encodeURIComponent(token)}`)}">← index</a></p>
    <article>
      <h1>${escapeHtml(rec.title)}</h1>
      <dl>
        <dt>Path</dt><dd><code>${escapeHtml(rec.path)}</code></dd>
        <dt>Folder</dt><dd>${renderFolderLink(rec.folder, token)}</dd>
        <dt>Tags</dt><dd>${rec.tags.length ? renderTagLinks(rec.tags, token) : "<span class=\"muted\">none</span>"}</dd>
        <dt>Source memories</dt><dd>${rec.sourceMemoryIds.length ? rec.sourceMemoryIds.join(", ") : "<span class=\"muted\">none</span>"}</dd>
        <dt>Updated</dt><dd>${new Date(rec.updatedAt).toISOString()}</dd>
      </dl>
      <pre>${linkWikiRefs(escapeHtml(rec.content), token)}</pre>
    </article>
  `;
}

function renderFolderList(
  folders: Array<{ path: string; title: string }>,
  token: string,
): string {
  return `<ul class="folders">${folders.map((f) =>
    `<li>${renderFolderLink(f.path, token)} <span class="muted">${escapeHtml(f.title)}</span></li>`,
  ).join("")}</ul>`;
}

function renderTagList(tags: Array<{ tag: string; count: number }>, token: string): string {
  return `<ul class="tag-list">${tags.map(({ tag, count }) =>
    `<li>${renderTagLink(tag, token)} <span class="muted">${count}</span></li>`,
  ).join("")}</ul>`;
}

function renderPageList(pages: PageListRecord[], token: string): string {
  if (pages.length === 0) return "";
  return `<ul class="pages">${pages.map((p) =>
    `<li><a href="${href(`/page?token=${encodeURIComponent(token)}&path=${encodeURIComponent(p.path)}`)}">${escapeHtml(p.title)}</a>` +
    ` <code>${escapeHtml(p.path)}</code> <span class="muted">${renderFolderLink(p.folder, token)}</span>` +
    `${p.tags.length ? ` <span class="tags">${renderTagLinks(p.tags, token)}</span>` : ""}</li>`,
  ).join("")}</ul>`;
}

function renderFolderLink(path: string, token: string): string {
  return `<a href="${href(`/folder?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`)}">${escapeHtml(path)}</a>`;
}

function renderTagLinks(tags: string[], token: string): string {
  return tags.map((tag) => renderTagLink(tag, token)).join(", ");
}

function renderTagLink(tag: string, token: string): string {
  return `<a href="${href(`/tag?token=${encodeURIComponent(token)}&tag=${encodeURIComponent(tag)}`)}">${escapeHtml(tag)}</a>`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px auto; max-width: 980px; padding: 0 18px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid #9995; margin-bottom: 18px; }
  h1 { font-size: 24px; margin: 12px 0; }
  h2 { font-size: 17px; margin-top: 24px; }
  form { display: flex; gap: 8px; }
  input { min-width: 260px; padding: 7px 9px; }
  button { padding: 7px 10px; }
  a { color: #0b62b4; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid #9995; border-radius: 6px; padding: 14px; }
  table { border-collapse: collapse; width: 100%; margin: 14px 0; }
  th, td { border: 1px solid #9995; padding: 7px 9px; text-align: left; vertical-align: top; }
  th { background: #9992; font-weight: 700; }
  .usage-table-wrap { max-width: 100%; overflow-x: auto; margin: 14px 0; border: 1px solid #9995; border-radius: 6px; }
  .usage-table { width: max-content; min-width: 100%; margin: 0; border: 0; }
  .usage-table th:first-child, .usage-table td:first-child { border-left: 0; }
  .usage-table th:last-child, .usage-table td:last-child { border-right: 0; }
  .usage-table thead:first-child th { border-top: 0; }
  .usage-table tbody:last-child tr:last-child td { border-bottom: 0; }
  .usage-table th, .usage-table td { white-space: nowrap; }
  .usage-table td { max-width: 280px; overflow-wrap: anywhere; }
  .usage-table td:nth-child(3),
  .usage-table td:nth-child(4),
  .usage-table td:nth-child(5),
  .usage-table td:nth-child(7),
  .usage-table td:nth-child(10) { white-space: normal; }
  dl { display: grid; grid-template-columns: 140px 1fr; gap: 4px 10px; }
  dt { font-weight: 700; }
  dd { margin: 0; }
  .muted { color: #777; }
  .folders { padding-left: 20px; }
  .folders li { margin: 7px 0; }
  .system-links { padding-left: 20px; }
  .system-links li { margin: 7px 0; }
  .tag-list { display: flex; flex-wrap: wrap; gap: 8px 14px; padding-left: 0; list-style: none; }
  .tag-list li { margin: 0; }
  .pages { padding-left: 20px; }
  .pages li { margin: 7px 0; }
  .tags { color: #777; font-size: 12px; }
</style>
</head>
<body>${body}</body>
</html>`;
}

function isAuthorized(req: IncomingMessage, url: URL, token: string): boolean {
  const bearer = req.headers.authorization;
  if (typeof bearer === "string" && bearer === `Bearer ${token}`) return true;
  return url.searchParams.get("token") === token;
}

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
  res.end(body);
}

function linkWikiRefs(escaped: string, token: string): string {
  return escaped.replace(/\[\[([^\]]+)\]\]/g, (_m, raw: string) => {
    const path = raw.trim();
    const label = escapeHtml(path);
    return `<a href="${href(`/page?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`)}">[[${label}]]</a>`;
  });
}

function href(value: string): string {
  return escapeHtml(value);
}

function collectTagCounts(pages: PageListRecord[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const page of pages) {
    for (const raw of page.tags) {
      const tag = raw.trim();
      if (!tag) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, count]) => ({ tag, count }));
}

function filterPagesByTag(pages: PageListRecord[], tag: string): PageListRecord[] {
  return pages.filter((page) => page.tags.some((t) => t === tag));
}

function hasLLMUsagePage(wiki: WikiStore): boolean {
  return typeof (wiki as Partial<LLMUsagePageReader>).readLLMUsageWikiPage === "function";
}

function readLLMUsagePage(wiki: WikiStore): WikiPageRecord | null {
  const reader = wiki as Partial<LLMUsagePageReader>;
  if (typeof reader.readLLMUsageWikiPage !== "function") return null;
  return reader.readLLMUsageWikiPage();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
