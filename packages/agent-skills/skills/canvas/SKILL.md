---
name: canvas
description: Author HTML scratchpad pages the user can open in a browser. Use when the user wants a rendered view, a table/report as a web page, or a visual scratchpad. Provides canvas_create, canvas_update, canvas_list, canvas_delete.
license: MIT
metadata:
  origin: miniclaw-builtin
---

# Canvas

A lightweight in-memory HTML scratchpad. Each canvas is a title + HTML body
fragment, addressable at `/canvas/<id>` if the gateway's HTTP server is mounted.

## Tools

- **`canvas_create`** — create a page from a title + HTML body fragment (the
  server adds `<head>`/styles). Returns the URL.
- **`canvas_update`** — replace a canvas's body (and optionally retitle).
- **`canvas_list`** — list canvases with their URLs.
- **`canvas_delete`** — delete a canvas by id.

## Notes

- Pages are stored in memory (per process) and are not persisted to disk.
- Rendered pages are served with a strict CSP sandbox (no script execution) —
  use HTML + inline styles, not `<script>`.
