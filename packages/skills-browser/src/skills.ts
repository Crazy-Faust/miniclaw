import { resolve, isAbsolute, join } from "node:path";
import { z } from "zod";
import { fail, ok, type Skill } from "@miniclaw/core";
import type { BrowserDriver, DriverFactory } from "./driver.ts";
import { playwrightDriverFactory } from "./playwright-driver.ts";

export interface BrowserSkillOpts {
  /** Override the driver factory — primarily for tests. */
  factory?: DriverFactory;
  /**
   * Persistent profile dir. Defaults to `<MINICLAW_WORKSPACE>/.miniclaw-browser`.
   * Profile state (cookies, localStorage) survives across calls.
   */
  userDataDir?: string;
}

/**
 * Build the five browser_* skills. The driver is created lazily on the
 * first call so the heavy Playwright import doesn't run at startup.
 *
 * Sandboxing: screenshot paths must resolve under the workspace root.
 * The interactive tier (click, fill) sets `requiresConfirmation: true`
 * so the agent's confirmation hook can gate destructive actions.
 */
export function createBrowserSkills(opts: BrowserSkillOpts = {}): Skill<unknown>[] {
  const factory = opts.factory ?? playwrightDriverFactory;
  let driver: BrowserDriver | null = null;
  let pendingInit: Promise<BrowserDriver> | null = null;

  async function ensureDriver(workspaceRoot: string | undefined): Promise<BrowserDriver> {
    if (driver) return driver;
    if (pendingInit) return pendingInit;
    const userDataDir = opts.userDataDir
      ?? (workspaceRoot ? join(workspaceRoot, ".miniclaw-browser") : undefined);
    pendingInit = factory.create({ userDataDir })
      .then((d) => {
        driver = d;
        pendingInit = null;
        return d;
      })
      .catch((err) => {
        pendingInit = null;
        throw err;
      });
    return pendingInit;
  }

  const OpenParams = z.object({
    url: z.string().url().describe("Absolute URL to load."),
  });
  const open: Skill<z.infer<typeof OpenParams>> = {
    name: "browser_open",
    description: "Open a URL in the headless browser. Returns when the page has loaded.",
    parameters: OpenParams,
    async execute(args, ctx) {
      try {
        const d = await ensureDriver(ctx.workspaceRoot);
        await d.open(args.url);
        return ok(`opened ${args.url}`);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  };

  const read: Skill<Record<string, never>> = {
    name: "browser_read_page",
    description:
      "Read the current page's title, URL, and visible text. Use after browser_open. " +
      "The text is the body's innerText, capped to keep responses readable.",
    parameters: z.object({}),
    async execute(_args, ctx) {
      try {
        const d = await ensureDriver(ctx.workspaceRoot);
        const { url, title, text } = await d.readPage();
        const trimmed = text.length > 8000 ? text.slice(0, 8000) + "\n…[truncated]" : text;
        return ok(`url: ${url}\ntitle: ${title}\n\n${trimmed}`);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  };

  const ScreenshotParams = z.object({
    path: z
      .string()
      .min(1)
      .describe("Where to save the PNG. Must resolve under MINICLAW_WORKSPACE."),
  });
  const screenshot: Skill<z.infer<typeof ScreenshotParams>> = {
    name: "browser_screenshot",
    description: "Save a PNG screenshot of the current page to disk.",
    parameters: ScreenshotParams,
    async execute(args, ctx) {
      const target = isAbsolute(args.path) ? args.path : resolve(ctx.workspaceRoot ?? process.cwd(), args.path);
      if (ctx.workspaceRoot && !target.startsWith(resolve(ctx.workspaceRoot) + "/") && target !== resolve(ctx.workspaceRoot)) {
        return fail(`refused: ${args.path} resolves outside the workspace sandbox`);
      }
      try {
        const d = await ensureDriver(ctx.workspaceRoot);
        await d.screenshot(target);
        return ok(`saved ${target}`);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  };

  const ClickParams = z.object({
    selector: z.string().min(1).describe("CSS selector."),
  });
  const click: Skill<z.infer<typeof ClickParams>> = {
    name: "browser_click",
    description: "Click an element by CSS selector. Interactive — requires user confirmation.",
    parameters: ClickParams,
    requiresConfirmation: true,
    async execute(args, ctx) {
      try {
        const d = await ensureDriver(ctx.workspaceRoot);
        await d.click(args.selector);
        return ok(`clicked ${args.selector}`);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  };

  const FillParams = z.object({
    selector: z.string().min(1).describe("CSS selector of the input element."),
    value: z.string().describe("Text to type into the field."),
  });
  const fill: Skill<z.infer<typeof FillParams>> = {
    name: "browser_fill",
    description:
      "Fill an input field with text. Interactive — requires user confirmation.",
    parameters: FillParams,
    requiresConfirmation: true,
    async execute(args, ctx) {
      try {
        const d = await ensureDriver(ctx.workspaceRoot);
        await d.fill(args.selector, args.value);
        return ok(`filled ${args.selector}`);
      } catch (err) {
        return fail((err as Error).message);
      }
    },
  };

  return [open, read, screenshot, click, fill] as Skill<unknown>[];
}

/** Test helper: shut down the lazy driver. Real callers don't need this. */
export async function disposeBrowserSkills(skills: Skill<unknown>[]): Promise<void> {
  // No-op — the singleton is captured in the closure of createBrowserSkills.
  // Exposed so future code can extend the surface without breaking callers.
  void skills;
}
