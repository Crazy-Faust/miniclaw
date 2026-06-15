import type { BrowserDriver, DriverFactory } from "./driver.ts";

// Late-binding wrapper around Playwright. Dynamic import keeps the
// dependency optional — workspaces without `playwright` installed still
// type-check; the error only surfaces at skill execution time, with a
// clear "install playwright" message.

interface PlaywrightModule {
  chromium: {
    launchPersistentContext(userDataDir: string, opts?: unknown): Promise<unknown>;
  };
}

interface ContextLike {
  newPage(): Promise<PageLike>;
  pages(): PageLike[];
  close(): Promise<void>;
}
interface PageLike {
  goto(url: string, opts?: unknown): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  innerText(selector: string): Promise<string>;
  screenshot(opts: { path: string; fullPage: boolean }): Promise<unknown>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
}

export const playwrightDriverFactory: DriverFactory = {
  async create(opts: { userDataDir?: string }): Promise<BrowserDriver> {
    let pw: PlaywrightModule;
    try {
      pw = (await import("playwright")) as unknown as PlaywrightModule;
    } catch (err) {
      throw new Error(
        `playwright is not installed. Run \`pnpm add -w playwright\` and \`pnpm exec playwright install chromium\` ` +
          `to enable the browser skill. (${(err as Error).message})`,
      );
    }
    const userDataDir = opts.userDataDir ?? `/tmp/miniclaw-browser-${process.pid}`;
    const context = (await pw.chromium.launchPersistentContext(userDataDir, {
      headless: true,
    })) as ContextLike;
    const page = await getOrCreatePage(context);

    return {
      async open(url: string): Promise<void> {
        await page.goto(url, { waitUntil: "domcontentloaded" });
      },
      async readPage(): Promise<{ url: string; title: string; text: string }> {
        const [title, text] = await Promise.all([page.title(), page.innerText("body")]);
        return { url: page.url(), title, text };
      },
      async screenshot(targetPath: string): Promise<void> {
        await page.screenshot({ path: targetPath, fullPage: true });
      },
      async click(selector: string): Promise<void> {
        await page.click(selector);
      },
      async fill(selector: string, value: string): Promise<void> {
        await page.fill(selector, value);
      },
      async close(): Promise<void> {
        await context.close();
      },
    };
  },
};

async function getOrCreatePage(context: ContextLike): Promise<PageLike> {
  const existing = context.pages();
  if (existing.length > 0) return existing[0]!;
  return await context.newPage();
}
