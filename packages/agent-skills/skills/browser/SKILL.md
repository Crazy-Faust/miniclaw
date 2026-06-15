---
name: browser
description: Drive a headless browser to open pages, read their text, screenshot them, and (with confirmation) click and fill forms. Use when a task needs to visit a web page interactively rather than just fetch its HTML. Provides browser_open, browser_read_page, browser_screenshot, browser_click, browser_fill.
license: MIT
compatibility: Requires the optional `playwright` peer dependency (pnpm add -w playwright && pnpm exec playwright install chromium). The tools are only registered when playwright is installed.
metadata:
  origin: miniclaw-builtin
---

# Browser

A Playwright-backed headless browser. The driver loads lazily on first use, so
there's no startup cost unless a browser tool is actually called.

## Tools

- **`browser_open`** — load an absolute URL.
- **`browser_read_page`** — read the current page's title, URL, and visible text
  (capped for readability). Use after `browser_open`.
- **`browser_screenshot`** — save a full-page PNG. The path must resolve under
  `MINICLAW_WORKSPACE`.
- **`browser_click`** — click a CSS selector. **Requires confirmation.**
- **`browser_fill`** — type into an input by CSS selector. **Requires
  confirmation.**

## Notes

- These tools only exist when `playwright` is installed; otherwise they are not
  registered at all.
- Profile state (cookies/localStorage) persists in `<workspace>/.miniclaw-browser`
  across calls within a run.
