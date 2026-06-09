/**
 * Captured realistic LLM tool-call sequences.
 *
 * Each entry represents what a real model returned for the stated user
 * message.  Tests consume these as scripted FakeLLM turns so the behaviour
 * under test is decoupled from network calls while still exercising
 * representative argument shapes.
 *
 * Convention: add new entries here when you capture a new sequence; never
 * duplicate an entry that already covers the same user message.
 */

import type { AssistantTurn } from "@miniclaw/core";

export interface RealisticScenario {
  /** The exact user message that produced this sequence. */
  userMessage: string;
  /** Ordered list of turns the LLM emitted (tool_use rounds + final). */
  turns: AssistantTurn[];
}

// ---------------------------------------------------------------------------
// Single-tool scenarios
// ---------------------------------------------------------------------------

export const REMEMBER_LANGUAGE_PREFERENCE: RealisticScenario = {
  userMessage: "Remember that I prefer TypeScript over JavaScript for all new projects",
  turns: [
    {
      kind: "tool_use",
      text: "I'll save that preference for you.",
      toolCalls: [
        {
          id: "toolu_mem_01",
          name: "write_memory",
          args: {
            content: "user prefers TypeScript over JavaScript for all new projects",
            kind: "preference",
            tags: ["typescript", "javascript", "language"],
          },
        },
      ],
    },
    {
      kind: "final",
      text: "Got it — I'll remember that you prefer TypeScript for new projects.",
    },
  ],
};

export const RECALL_EDITOR_PREFERENCE: RealisticScenario = {
  userMessage: "What editor do I prefer?",
  turns: [
    {
      kind: "tool_use",
      text: "Let me search your memories for editor preferences.",
      toolCalls: [
        {
          id: "toolu_srch_01",
          name: "search_memory",
          args: { query: "editor preference" },
        },
      ],
    },
    {
      kind: "final",
      text: "Based on your stored preferences, you prefer the helix editor.",
    },
  ],
};

export const QUERY_MEMORY_COUNT: RealisticScenario = {
  userMessage: "How many things have you stored about me?",
  turns: [
    {
      kind: "tool_use",
      text: "Let me query the memory database to get a count.",
      toolCalls: [
        {
          id: "toolu_sql_01",
          name: "sql_query",
          args: {
            sql: "SELECT COUNT(*) AS total, kind FROM memories GROUP BY kind ORDER BY total DESC",
            limit: 20,
          },
        },
      ],
    },
    {
      kind: "final",
      text: "I've stored a few memories about you across different categories.",
    },
  ],
};

export const LIST_FILES_IN_WORKSPACE: RealisticScenario = {
  userMessage: "What files are at the root of my workspace?",
  turns: [
    {
      kind: "tool_use",
      text: "I'll list the workspace root for you.",
      toolCalls: [
        {
          id: "toolu_ls_01",
          name: "shell",
          args: { bin: "ls", args: ["-1"] },
        },
      ],
    },
    {
      kind: "final",
      text: "Here are the files at your workspace root.",
    },
  ],
};

export const PLAN_AUTH_FEATURE: RealisticScenario = {
  userMessage: "I need to add JWT authentication to my app. Help me track the steps.",
  turns: [
    {
      kind: "tool_use",
      text: "I'll create a plan to track the authentication implementation.",
      toolCalls: [
        {
          id: "toolu_todo_01",
          name: "todo_write",
          args: {
            items: [
              { content: "Install JWT library and update package.json", status: "pending" },
              { content: "Create auth middleware that validates Bearer tokens", status: "pending" },
              { content: "Add /login endpoint that issues signed JWTs", status: "pending" },
              { content: "Protect private routes with the auth middleware", status: "pending" },
              { content: "Write integration tests for auth flow", status: "pending" },
            ],
          },
        },
      ],
    },
    {
      kind: "final",
      text: "I've created a 5-step plan for your JWT authentication feature. Start with installing the library.",
    },
  ],
};

// ---------------------------------------------------------------------------
// Multi-tool scenarios (realistic chaining)
// ---------------------------------------------------------------------------

export const SEARCH_THEN_UPDATE_MEMORY: RealisticScenario = {
  userMessage:
    "I just decided to switch from React to Vue for all future frontend work. Update your notes.",
  turns: [
    {
      kind: "tool_use",
      text: "Let me first check what I already have about your frontend preferences.",
      toolCalls: [
        {
          id: "toolu_srch_02",
          name: "search_memory",
          args: { query: "frontend framework preference React" },
        },
      ],
    },
    {
      kind: "tool_use",
      text: "Found prior notes. I'll now store your updated preference.",
      toolCalls: [
        {
          id: "toolu_mem_02",
          name: "write_memory",
          args: {
            content: "user prefers Vue over React for all future frontend projects",
            kind: "preference",
            tags: ["vue", "react", "frontend", "framework"],
          },
        },
      ],
    },
    {
      kind: "final",
      text: "Done — I've updated your frontend framework preference to Vue.",
    },
  ],
};

export const CHECK_GIT_STATUS_THEN_LOG: RealisticScenario = {
  userMessage: "Show me the git status and the last 3 commits in my workspace.",
  turns: [
    {
      kind: "tool_use",
      text: "I'll check the current git status first.",
      toolCalls: [
        {
          id: "toolu_git_01",
          name: "shell",
          args: { bin: "git", args: ["status"] },
        },
      ],
    },
    {
      kind: "tool_use",
      text: "Now let me pull the recent commit history.",
      toolCalls: [
        {
          id: "toolu_git_02",
          name: "shell",
          args: { bin: "git", args: ["log", "--oneline", "-3"] },
        },
      ],
    },
    {
      kind: "final",
      text: "Here's a summary of your repository's current state and recent history.",
    },
  ],
};

export const COUNT_FILES_BY_EXTENSION: RealisticScenario = {
  userMessage: "How many TypeScript files are in my project?",
  turns: [
    {
      kind: "tool_use",
      text: "I'll use find to locate all TypeScript files.",
      toolCalls: [
        {
          id: "toolu_find_01",
          name: "shell",
          args: { bin: "find", args: [".", "-name", "*.ts", "-not", "-path", "*/node_modules/*", "-type", "f"] },
        },
      ],
    },
    {
      kind: "tool_use",
      text: "Now let me also confirm the directory structure.",
      toolCalls: [
        {
          id: "toolu_ls_03",
          name: "shell",
          args: { bin: "ls", args: ["-1"] },
        },
      ],
    },
    {
      kind: "final",
      text: "Here's the TypeScript file count for your project.",
    },
  ],
};

export const PLAN_THEN_MARK_FIRST_IN_PROGRESS: RealisticScenario = {
  userMessage: "Plan out writing a README, then start on the first task.",
  turns: [
    {
      kind: "tool_use",
      text: "I'll set up the plan first.",
      toolCalls: [
        {
          id: "toolu_todo_02",
          name: "todo_write",
          args: {
            items: [
              { content: "Draft the project overview section", status: "pending" },
              { content: "Document installation steps", status: "pending" },
              { content: "Add usage examples with code snippets", status: "pending" },
              { content: "Write contributing guidelines", status: "pending" },
            ],
          },
        },
      ],
    },
    {
      kind: "tool_use",
      text: "Now marking the first item as in progress.",
      toolCalls: [
        {
          id: "toolu_todo_03",
          name: "todo_write",
          args: {
            items: [
              { id: 1, content: "Draft the project overview section", status: "in_progress" },
              { content: "Document installation steps", status: "pending" },
              { content: "Add usage examples with code snippets", status: "pending" },
              { content: "Write contributing guidelines", status: "pending" },
            ],
          },
        },
      ],
    },
    {
      kind: "final",
      text: "Plan is ready and I've started on drafting the project overview. Let me know when you'd like to move on.",
    },
  ],
};

// ---------------------------------------------------------------------------
// Error-recovery scenarios
// ---------------------------------------------------------------------------

export const SHELL_REFUSES_THEN_FALLS_BACK: RealisticScenario = {
  userMessage: "Delete all temporary files and then show me what's left.",
  turns: [
    {
      kind: "tool_use",
      text: "I'll attempt to clean up and then list the directory.",
      toolCalls: [
        // rm is not allowlisted → agent returns ok=false with "refused"
        { id: "toolu_rm_01", name: "shell", args: { bin: "rm", args: ["-rf", "/tmp/scratch"] } },
        // ls runs regardless because the agent processes all calls in the round
        { id: "toolu_ls_02", name: "shell", args: { bin: "ls", args: ["-1"] } },
      ],
    },
    {
      kind: "final",
      text: "I couldn't delete the files (rm is not an allowed command), but here's the current directory listing.",
    },
  ],
};

export const SEARCH_MEMORY_EMPTY_THEN_WRITE: RealisticScenario = {
  userMessage: "Do you know my preferred shell? If not, save that I use zsh.",
  turns: [
    {
      kind: "tool_use",
      text: "Let me search first to avoid a duplicate.",
      toolCalls: [
        {
          id: "toolu_srch_03",
          name: "search_memory",
          args: { query: "preferred shell zsh bash" },
        },
      ],
    },
    {
      // No match found → model decides to write
      kind: "tool_use",
      text: "No prior entry found. I'll save it now.",
      toolCalls: [
        {
          id: "toolu_mem_03",
          name: "write_memory",
          args: {
            content: "user prefers zsh as their default shell",
            kind: "preference",
            tags: ["shell", "zsh", "terminal"],
          },
        },
      ],
    },
    {
      kind: "final",
      text: "I didn't have that stored yet, so I've saved that you prefer zsh.",
    },
  ],
};
