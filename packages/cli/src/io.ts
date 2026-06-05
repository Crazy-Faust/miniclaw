import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { IOAdapter } from "@miniclaw/harness";

// node:readline-based IOAdapter for interactive use. The only place in the
// codebase that touches stdin — swap this out for a different front-end
// without touching the loop logic.
export function createReadlineIO(): IOAdapter {
  const rl = readline.createInterface({ input, output });

  return {
    async readLine(prompt: string): Promise<string | null> {
      try {
        return await rl.question(prompt);
      } catch {
        // rl.question throws on close / abort — treat as EOF.
        return null;
      }
    },
    write(text: string): void {
      output.write(text);
    },
    onToolCall(name: string, args: unknown): void {
      output.write(`  · tool ${name}(${truncate(JSON.stringify(args), 120)})\n`);
    },
    async confirm(prompt: string): Promise<boolean> {
      try {
        const answer = (await rl.question(prompt)).trim().toLowerCase();
        return answer === "y" || answer === "yes";
      } catch {
        return false;
      }
    },
    close(): void {
      rl.close();
    },
  };
}

// One-shot IOAdapter: emits a single scripted line then EOF. Used for
// `miniclaw "do X"` — the harness reads the prompt, runs one agent turn,
// then terminates because the next readLine() returns null.
export function createOneShotIO(promptText: string): IOAdapter {
  let consumed = false;
  return {
    async readLine(): Promise<string | null> {
      if (consumed) return null;
      consumed = true;
      return promptText;
    },
    write(text: string): void {
      output.write(text);
    },
    onToolCall(name: string, args: unknown): void {
      output.write(`  · tool ${name}(${truncate(JSON.stringify(args), 120)})\n`);
    },
    close(): void {
      // Nothing to release.
    },
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
