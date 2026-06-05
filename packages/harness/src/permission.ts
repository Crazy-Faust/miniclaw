/**
 * Per-skill permission memoization. After the user approves a sensitive
 * tool call with "remember", the next call to the same skill in the same
 * session (or, optionally, with the same args) skips the prompt.
 *
 * Three scopes are supported, mirroring the way most agent UIs phrase the
 * decision: just this once, this session, or — when a persistence layer
 * is plugged in — this project.
 */

export type PermissionScope = "once" | "session" | "project" | "deny";

export interface PermissionDecision {
  scope: PermissionScope;
  /** When true, the memo is keyed by (skill, args fingerprint) instead of skill only. */
  perArgs?: boolean;
}

export interface PermissionPersistence {
  /** Read previously-persisted decisions for the project. */
  load(): Promise<string[]>;
  /** Persist that a skill has been approved at project scope. */
  add(key: string): Promise<void>;
}

export interface PermissionMemoOpts {
  /** Persistence backend for "project"-scope approvals (e.g. on-disk JSON). */
  persistence?: PermissionPersistence;
  /**
   * Hash function for arg fingerprinting. Defaults to JSON.stringify;
   * tests can supply a deterministic stub for non-JSON-safe values.
   */
  hashArgs?(args: unknown): string;
}

export class PermissionMemo {
  private readonly sessionApproved = new Set<string>();
  private readonly projectApproved = new Set<string>();
  private readonly persistence: PermissionPersistence | undefined;
  private readonly hashArgs: (args: unknown) => string;
  private hydrated = false;

  constructor(opts: PermissionMemoOpts = {}) {
    this.persistence = opts.persistence;
    this.hashArgs = opts.hashArgs ?? defaultHashArgs;
  }

  /** Hydrate project-scope memoizations from persistence. Call once at startup. */
  async hydrate(): Promise<void> {
    if (this.hydrated || !this.persistence) {
      this.hydrated = true;
      return;
    }
    const keys = await this.persistence.load();
    for (const k of keys) this.projectApproved.add(k);
    this.hydrated = true;
  }

  /** Has this skill (and optionally args) been approved? */
  isApproved(skillName: string, args?: unknown): boolean {
    if (this.sessionApproved.has(skillKey(skillName)) || this.projectApproved.has(skillKey(skillName))) {
      return true;
    }
    if (args !== undefined) {
      const argKey = argsKey(skillName, this.hashArgs(args));
      return this.sessionApproved.has(argKey) || this.projectApproved.has(argKey);
    }
    return false;
  }

  /** Record an approval at the requested scope. */
  async remember(skillName: string, decision: PermissionDecision, args?: unknown): Promise<void> {
    if (decision.scope === "once" || decision.scope === "deny") return;
    const key = decision.perArgs && args !== undefined
      ? argsKey(skillName, this.hashArgs(args))
      : skillKey(skillName);
    if (decision.scope === "session") {
      this.sessionApproved.add(key);
      return;
    }
    if (decision.scope === "project") {
      this.projectApproved.add(key);
      if (this.persistence) await this.persistence.add(key);
    }
  }

  /** Forget everything (session AND in-memory project cache). */
  clear(): void {
    this.sessionApproved.clear();
    this.projectApproved.clear();
  }

  /**
   * Wrap an "ask the user" function so approvals at session/project scope
   * skip the prompt next time. The wrapped function returns boolean
   * (suitable for AgentDeps.confirmTool) — yes for approved, no for denied.
   */
  wrap(
    ask: (
      call: { name: string; args: unknown },
      skill: { name: string; description: string },
    ) => Promise<PermissionDecision>,
  ): (
    call: { name: string; args: unknown },
    skill: { name: string; description: string },
  ) => Promise<boolean> {
    return async (call, skill) => {
      if (this.isApproved(call.name, call.args)) return true;
      const decision = await ask(call, skill);
      await this.remember(call.name, decision, call.args);
      return decision.scope !== "deny";
    };
  }
}

function defaultHashArgs(args: unknown): string {
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function skillKey(name: string): string {
  return `skill:${name}`;
}

function argsKey(name: string, hash: string): string {
  return `skill:${name}:args:${hash}`;
}
