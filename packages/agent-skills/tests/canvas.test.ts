import { describe, expect, it } from "vitest";
import type { AuditSink, MemoryStore, SkillContext } from "@miniclaw/core";
import { CanvasStore } from "../skills/canvas/store.ts";
import { createCanvasSkills } from "../skills/canvas/handler.ts";
import { handleCanvasRequest } from "../skills/canvas/server.ts";

function makeCtx(): SkillContext {
  return { memory: {} as MemoryStore, audit: {} as AuditSink, dbPath: ":memory:" };
}

describe("CanvasStore", () => {
  it("creates, updates, lists, and deletes", () => {
    const store = new CanvasStore();
    const a = store.create("a", "<p>hi</p>");
    const b = store.create("b", "<p>bye</p>");
    expect(store.list().map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    store.update(a.id, "<p>updated</p>");
    expect(store.get(a.id)!.html).toBe("<p>updated</p>");
    expect(store.delete(b.id)).toBe(true);
    expect(store.list()).toHaveLength(1);
  });
});

describe("canvas skills", () => {
  it("canvas_create stores and returns a URL", async () => {
    const store = new CanvasStore();
    const [create] = createCanvasSkills({ store, baseUrl: "http://localhost:9999" });
    const res = await create!.execute({ title: "demo", html: "<h1>hi</h1>" }, makeCtx());
    expect(res.ok).toBe(true);
    expect(res.output).toMatch(/http:\/\/localhost:9999\/canvas\/c1/);
  });
});

describe("handleCanvasRequest", () => {
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

  it("returns 404 for an unknown id", () => {
    const store = new CanvasStore();
    const r = makeRes();
    const handled = handleCanvasRequest(
      { method: "GET", url: "/canvas/missing" } as any,
      r.res,
      store,
    );
    expect(handled).toBe(true);
    expect(r.get().status).toBe(404);
  });

  it("renders an existing canvas with the framed page template", () => {
    const store = new CanvasStore();
    const c = store.create("hello", "<h1>greetings</h1>");
    const r = makeRes();
    handleCanvasRequest(
      { method: "GET", url: `/canvas/${c.id}` } as any,
      r.res,
      store,
    );
    const out = r.get();
    expect(out.status).toBe(200);
    expect(out.body).toContain("<title>hello</title>");
    expect(out.body).toContain("<h1>greetings</h1>");
  });

  it("returns false for unrelated URLs", () => {
    const r = makeRes();
    expect(
      handleCanvasRequest(
        { method: "GET", url: "/something-else" } as any,
        r.res,
        new CanvasStore(),
      ),
    ).toBe(false);
  });
});
