// Minimal driver interface. Real impl: ./playwright-driver.ts; tests
// inject a fake. Skills never touch playwright directly so swapping the
// engine (puppeteer, headless chrome bridge, ...) means writing one
// adapter instead of editing five skills.

export interface BrowserDriver {
  open(url: string): Promise<void>;
  readPage(): Promise<{ url: string; title: string; text: string }>;
  screenshot(targetPath: string): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  close(): Promise<void>;
}

export interface DriverFactory {
  /**
   * Open (or reuse) a single persistent browser context. The factory is
   * cached for the life of the skill instance; the skill calls open()
   * lazily so the first turn pays the startup cost and later turns are
   * cheap.
   */
  create(opts: { userDataDir?: string }): Promise<BrowserDriver>;
}
