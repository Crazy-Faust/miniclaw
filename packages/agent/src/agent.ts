import type {
  AssistantTurn,
  AuditSink,
  ContextManager,
  LLMProvider,
  MemoryStore,
  Message,
  SkillContext,
  SkillRegistry,
  ToolCall,
  ToolResultPart,
  ToolSpec,
} from "@miniclaw/core";

const MAX_ROUNDS = 6;

export interface AgentRetryOptions {
  /** Total attempts, including the first. Defaults to 3. Set to 1 to disable retry. */
  maxAttempts?: number;
  /** First backoff delay in ms. Subsequent delays double. Defaults to 200. */
  baseDelayMs?: number;
  /** Jitter multiplier in [0,1] applied as `delay * (1 + jitter*Math.random())`. */
  jitter?: number;
  /** Classify whether an error is worth retrying. Default: 429 and 5xx-shaped. */
  isTransient?: (err: unknown) => boolean;
  /** Injectable sleep so tests can run instantly. Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface AgentDeps {
  llm: LLMProvider;
  registry: SkillRegistry;
  context: ContextManager;
  memory: MemoryStore;
  audit: AuditSink;
  dbPath: string;
  /** Logical session/channel id threaded to skills via SkillContext. */
  channel?: string;
  /** Workspace sandbox root threaded to every skill via SkillContext. */
  workspaceRoot?: string;
  /**
   * Asked before running any skill where requiresConfirmation === true.
   * Should resolve to true to proceed, false to deny. If omitted and a
   * skill requires confirmation, the agent fails closed (denies it).
   */
  confirmTool?: (
    call: { name: string; args: unknown },
    skill: { name: string; description: string },
  ) => Promise<boolean>;
  /** Optional retry policy applied around LLM provider calls. */
  retry?: AgentRetryOptions;
}

export interface PreToolUseDecision {
  /** When false, the agent refuses the tool call and records `reason` as the tool result. */
  allow: boolean;
  /** Reason shown back to the model when allow=false. Defaults to a generic message. */
  reason?: string;
  /**
   * When allow=true, optionally replace the args the model proposed before
   * the skill runs. The agent re-validates the new args against the skill's
   * zod schema, so invalid replacements surface as a clean "invalid arguments"
   * tool result rather than corrupting the call.
   */
  modifiedArgs?: unknown;
}

export interface AgentTurnHooks {
  /** Fires before each tool call dispatches. */
  onTool?: (name: string, args: unknown) => void;
  /**
   * Fires once per tool_use round with the assistant's narration text
   * (e.g. "Let me check that..." emitted alongside a tool call). Lets the
   * UI show progress between rounds instead of going silent until the
   * final answer. Only called when the text is non-empty.
   */
  onIntermediateText?: (text: string) => void;
  /**
   * Fires per token/chunk as the provider streams. Providers without
   * streaming support never call this. Streaming UIs should rely on
   * this and ignore onIntermediateText / TurnTrace.finalText to avoid
   * double-rendering.
   */
  onAssistantToken?: (delta: string) => void;
  /**
   * Fires AFTER arg validation but BEFORE skill.execute. The hook can veto
   * the call (returning allow=false), or rewrite args (returning
   * modifiedArgs). Use this for project-level guardrails, audit recording,
   * or workflow gates that the skill itself shouldn't know about.
   *
   * Returning void/undefined is equivalent to { allow: true }.
   */
  onPreToolUse?(
    call: { name: string; args: unknown },
    skill: { name: string; description: string },
  ): Promise<PreToolUseDecision | void> | PreToolUseDecision | void;
  /**
   * Fires AFTER skill.execute returns (or after a refusal). Strictly
   * observational — for logging, metrics, follow-up notifications.
   */
  onPostToolUse?(
    call: { name: string; args: unknown },
    result: { ok: boolean; output: string },
  ): Promise<void> | void;
}

export interface TurnTrace {
  toolCalls: Array<{ name: string; args: unknown; ok: boolean; output: string }>;
  finalText: string;
}

export class Agent {
  constructor(private readonly deps: AgentDeps) {}

  async runTurn(userMsg: string, hooks?: AgentTurnHooks): Promise<TurnTrace> {
    this.deps.context.recordUser(userMsg);
    const { system, messages } = this.deps.context.prepare(userMsg);
    const skillCtx: SkillContext = {
      memory: this.deps.memory,
      audit: this.deps.audit,
      dbPath: this.deps.dbPath,
      channel: this.deps.channel,
      workspaceRoot: this.deps.workspaceRoot,
    };
    const trace: TurnTrace = { toolCalls: [], finalText: "" };
    const working: Message[] = [...messages];

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const turn = await this.chatWithRetry({
        system,
        messages: working,
        tools: this.deps.registry.toolSpecs(),
        onToken: hooks?.onAssistantToken,
      });

      if (turn.kind === "final") {
        trace.finalText = turn.text;
        this.deps.context.recordAssistant(turn.text);
        return trace;
      }

      // Surface narration emitted alongside tool calls. Without this the UI
      // is silent between the user's message and the final answer, even
      // when the model said "let me check that for you" first.
      if (turn.text) hooks?.onIntermediateText?.(turn.text);

      working.push({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls });
      const results: ToolResultPart[] = [];
      for (const call of turn.toolCalls) {
        hooks?.onTool?.(call.name, call.args);
        const { content, ok } = await this.executeOne(call, skillCtx, trace, hooks);
        results.push({ toolCallId: call.id, toolName: call.name, content, isError: !ok });
      }
      // Persist what the model actually emitted — the real text, not a
      // synthetic "(tool use)" sentinel. The toolCallsJson carries the
      // tool-use side, so the conversation row reflects both faithfully.
      this.deps.context.recordAssistant(turn.text, JSON.stringify(turn.toolCalls));
      working.push({ role: "tool", results });
    }

    const msg = `(tool-call round limit of ${MAX_ROUNDS} exceeded)`;
    trace.finalText = msg;
    this.deps.context.recordAssistant(msg);
    return trace;
  }

  private async chatWithRetry(opts: {
    system: string;
    messages: Message[];
    tools: ToolSpec[];
    onToken?: (delta: string) => void;
  }): Promise<AssistantTurn> {
    const r = this.deps.retry ?? {};
    const maxAttempts = Math.max(1, r.maxAttempts ?? 3);
    const baseDelayMs = r.baseDelayMs ?? 200;
    const jitter = r.jitter ?? 0.3;
    const isTransient = r.isTransient ?? defaultIsTransient;
    const sleep = r.sleep ?? defaultSleep;

    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this.deps.llm.chat(opts);
      } catch (err) {
        lastErr = err;
        if (attempt >= maxAttempts - 1) throw err;
        if (!isTransient(err)) throw err;
        const delay = Math.round(
          baseDelayMs * Math.pow(2, attempt) * (1 + jitter * Math.random()),
        );
        await sleep(delay);
      }
    }
    // Unreachable in practice — the loop either returns or throws.
    throw lastErr;
  }

  private async executeOne(
    call: ToolCall,
    skillCtx: SkillContext,
    trace: TurnTrace,
    hooks?: AgentTurnHooks,
  ): Promise<{ content: string; ok: boolean }> {
    const argsJson = safeStringify(call.args);
    const finish = async (
      skillName: string,
      argsForTrace: unknown,
      content: string,
      ok: boolean,
    ): Promise<{ content: string; ok: boolean }> => {
      this.deps.audit.logToolCall(skillName, argsJson, summarize(content), ok);
      trace.toolCalls.push({ name: skillName, args: argsForTrace, ok, output: content });
      // Post-tool hook is observational — failures here must not poison
      // the agent loop, so swallow throws and surface them via console.
      if (hooks?.onPostToolUse) {
        try {
          await hooks.onPostToolUse(
            { name: skillName, args: argsForTrace },
            { ok, output: content },
          );
        } catch {
          // Intentionally silent — observer-side errors are not the agent's
          // problem and must not break the turn.
        }
      }
      return { content, ok };
    };

    if (!this.deps.registry.has(call.name)) {
      return await finish(call.name, call.args, `unknown tool: ${call.name}`, false);
    }
    const skill = this.deps.registry.get(call.name);

    // PreToolUse hook runs BEFORE arg validation runs against the model's
    // proposed args, so the hook gets a chance to rewrite/veto the call.
    let proposedArgs: unknown = call.args;
    if (hooks?.onPreToolUse) {
      const decision = await hooks.onPreToolUse(
        { name: call.name, args: call.args },
        { name: skill.name, description: skill.description },
      );
      if (decision && decision.allow === false) {
        const reason = decision.reason ?? "tool call denied by PreToolUse hook";
        return await finish(skill.name, call.args, reason, false);
      }
      if (decision && decision.modifiedArgs !== undefined) {
        proposedArgs = decision.modifiedArgs;
      }
    }

    const parsed = skill.parameters.safeParse(proposedArgs);
    if (!parsed.success) {
      return await finish(
        skill.name,
        proposedArgs,
        `invalid arguments: ${parsed.error.message}`,
        false,
      );
    }
    if (skill.requiresConfirmation) {
      const approved = this.deps.confirmTool
        ? await this.deps.confirmTool(
            { name: call.name, args: parsed.data },
            { name: skill.name, description: skill.description },
          )
        : false; // fail closed: if there's no UI to ask, deny.
      if (!approved) {
        const msg = this.deps.confirmTool
          ? "user declined this tool call"
          : "tool requires confirmation but no confirmation handler is configured";
        return await finish(skill.name, parsed.data, msg, false);
      }
    }
    try {
      const res = await skill.execute(parsed.data, skillCtx);
      return await finish(skill.name, parsed.data, res.output, res.ok);
    } catch (err) {
      const msg = `tool threw: ${(err as Error).message ?? String(err)}`;
      return await finish(skill.name, call.args, msg, false);
    }
  }
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function summarize(s: string, max = 500): string {
  return s.length <= max ? s : s.slice(0, max) + `... (+${s.length - max} bytes)`;
}

export function defaultIsTransient(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const e = err as { status?: number; statusCode?: number; code?: unknown; message?: string };
  const numericCode =
    typeof e.status === "number" ? e.status :
    typeof e.statusCode === "number" ? e.statusCode :
    typeof e.code === "number" ? (e.code as number) : undefined;
  if (typeof numericCode === "number") {
    if (numericCode === 429) return true;
    if (numericCode === 408) return true;
    if (numericCode >= 500 && numericCode < 600) return true;
    return false;
  }
  const msg = (e.message ?? String(err)).toLowerCase();
  // Heuristic match for providers that throw plain Error with a status word.
  return /(^|\D)429(\D|$)|rate.?limit|overload|(^|\D)5\d{2}(\D|$)|temporar(y|ily)|unavailab|bad gateway|gateway timeout|timed? out|econn(reset|aborted|refused)|etimedout/.test(
    msg,
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
