import { describe, expect, it } from "vitest";
import type {
  WikiFolderRecord,
  WikiPageInput,
  WikiPageRecord,
  WikiSearchResult,
  WikiStore,
  WikiMaintenanceAction,
} from "@miniclaw/core";
import { startWikiBrowserServer } from "../src/index.ts";

class FakeWiki implements WikiStore {
  pages: WikiPageRecord[] = [];
  folders: WikiFolderRecord[] = [{ path: "personal", title: "Personal", createdAt: 1, updatedAt: 1 }];

  upsertWikiPage(input: WikiPageInput): void {
    const now = Date.now();
    this.pages.push({
      path: input.path,
      folder: input.folder ?? "personal",
      title: input.title,
      content: input.content,
      tags: input.tags ?? [],
      sourceMemoryIds: input.sourceMemoryIds ?? [],
      createdAt: now,
      updatedAt: now,
    });
  }
  readWikiPage(path: string): WikiPageRecord | null {
    return this.pages.find((p) => p.path === path) ?? null;
  }
  listWikiPages(_folder?: string, limit = 50): WikiPageRecord[] {
    return this.pages.slice(0, limit);
  }
  listWikiFolders(): WikiFolderRecord[] {
    return this.folders;
  }
  searchWiki(query: string, limit = 5): WikiSearchResult[] {
    const q = query.toLowerCase();
    return this.pages
      .filter((p) => `${p.title} ${p.content}`.toLowerCase().includes(q))
      .slice(0, limit)
      .map((p) => ({
        path: p.path,
        folder: p.folder,
        title: p.title,
        content: p.content,
        tags: p.tags,
        sourceMemoryIds: p.sourceMemoryIds,
      }));
  }
  addWikiLink(): void {}
  appendWikiLog(): number { return 1; }
  applyWikiMaintenanceActions(_actions: WikiMaintenanceAction[]): void {}
  updateMemoryMetadata(): void {}
}

describe("wiki browser", () => {
  it("serves an authenticated index, search page, page view, and JSON page", async () => {
    const wiki = new FakeWiki();
    wiki.upsertWikiPage({
      path: "personal/preferences.md",
      folder: "personal",
      title: "Preferences",
      content: "# Preferences\nUser likes [[personal/editor.md]] and <script>bad()</script>",
      tags: ["preferences"],
      sourceMemoryIds: [7],
    });
    const handle = await startWikiBrowserServer({ wiki, token: "test-token" });
    try {
      const denied = await fetch(handle.url.replace("test-token", "bad-token"));
      expect(denied.status).toBe(401);

      const index = await fetch(handle.url);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain("Preferences");

      const search = await fetch(`${handle.url}&q=nope`.replace("/?", "/search?"));
      expect(search.status).toBe(200);

      const page = await fetch(`${handle.url}&path=${encodeURIComponent("personal/preferences.md")}`.replace("/?", "/page?"));
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(html).toContain("Source memories");
      expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
      expect(html).toContain("[[personal/editor.md]]");

      const json = await fetch(`${handle.url}&path=${encodeURIComponent("personal/preferences.md")}`.replace("/?", "/api/page?"));
      expect(json.status).toBe(200);
      await expect(json.json()).resolves.toMatchObject({ path: "personal/preferences.md" });
    } finally {
      await handle.stop();
    }
  });
});
