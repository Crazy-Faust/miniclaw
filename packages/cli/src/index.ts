#!/usr/bin/env tsx
import { main } from "./main.ts";

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
