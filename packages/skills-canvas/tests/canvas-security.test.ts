import { describe, expect, it } from "vitest";
import { CanvasStore } from "../src/store.ts";
import { handleCanvasRequest } from "../src/server.ts";

// VULN-17: Canvas CSP/sandbox headers
describe("handleCanvasRequest — security headers (VULN-17)", () => {
  function makeRes() {
    let status = 0;
    let headers: Record<string, string | number> = {};
    let body = "";
    return {
      res: {
        writeHead(s: number, h: Record<string, string | number>) {
          status = s;
          headers = h;
        },
        end(b: string) { body = b; },
      } as any,
      get: () => ({ status, headers, body }),
    };
  }

  it("serves canvas pages with Content-Security-Policy: sandbox", () => {
    const store = new CanvasStore();
    const c = store.create("test", "<h1>hello</h1>");
    const r = makeRes();
    handleCanvasRequest(
      { method: "GET", url: `/canvas/${c.id}` } as any,
      r.res,
      store,
    );
    const out = r.get();
    expect(out.status).toBe(200);
    expect(out.headers["content-security-policy"]).toMatch(/sandbox/);
    expect(out.headers["content-security-policy"]).toMatch(/default-src 'none'/);
  });

  it("serves canvas pages with X-Content-Type-Options: nosniff", () => {
    const store = new CanvasStore();
    const c = store.create("test", "<h1>hello</h1>");
    const r = makeRes();
    handleCanvasRequest(
      { method: "GET", url: `/canvas/${c.id}` } as any,
      r.res,
      store,
    );
    expect(r.get().headers["x-content-type-options"]).toBe("nosniff");
  });

  it("serves canvas pages with X-Frame-Options: DENY", () => {
    const store = new CanvasStore();
    const c = store.create("test", "<h1>hello</h1>");
    const r = makeRes();
    handleCanvasRequest(
      { method: "GET", url: `/canvas/${c.id}` } as any,
      r.res,
      store,
    );
    expect(r.get().headers["x-frame-options"]).toBe("DENY");
  });

  it("does NOT apply sandbox headers to the canvas list page", () => {
    const store = new CanvasStore();
    const r = makeRes();
    handleCanvasRequest(
      { method: "GET", url: "/canvas" } as any,
      r.res,
      store,
    );
    const out = r.get();
    expect(out.status).toBe(200);
    // List page uses sendHtml (not sendSandboxedHtml), so no CSP header
    expect(out.headers["content-security-policy"]).toBeUndefined();
  });
});
