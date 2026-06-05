import { defineConfig } from "vitest/config";

// Default include is **/*.{test,spec}.ts; default exclude covers node_modules
// etc. So this config works both from the workspace root (discovers all
// packages) and from inside a single package (discovers just its tests).
export default defineConfig({});
