// In-memory scratchpad. Each canvas is a title + HTML blob keyed by a
// short URL-safe id. The handler in ./server.ts can render them at
// `/canvas/:id` when mounted on an HTTP server.

export interface CanvasRecord {
  id: string;
  title: string;
  html: string;
  updatedAt: number;
}

export class CanvasStore {
  private seq = 0;
  private readonly canvases = new Map<string, CanvasRecord>();

  /** Insert a new canvas. Returns the new record (with its assigned id). */
  create(title: string, html: string): CanvasRecord {
    const id = `c${++this.seq}`;
    const rec: CanvasRecord = { id, title, html, updatedAt: Date.now() };
    this.canvases.set(id, rec);
    return { ...rec };
  }

  /** Replace the HTML body of an existing canvas. Returns null if not found. */
  update(id: string, html: string, title?: string): CanvasRecord | null {
    const rec = this.canvases.get(id);
    if (!rec) return null;
    rec.html = html;
    if (title !== undefined) rec.title = title;
    rec.updatedAt = Date.now();
    return { ...rec };
  }

  get(id: string): CanvasRecord | null {
    const rec = this.canvases.get(id);
    return rec ? { ...rec } : null;
  }

  list(): CanvasRecord[] {
    return [...this.canvases.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((r) => ({ ...r }));
  }

  delete(id: string): boolean {
    return this.canvases.delete(id);
  }
}
