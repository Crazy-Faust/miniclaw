import { Agent } from "@miniclaw/agent";
import { StatelessContextManager } from "@miniclaw/context-stateless";
import { CompactingContextManager } from "@miniclaw/context-windowed";
import { createDreamSkill, Dreamer, formatDreamRunResult } from "@miniclaw/dreaming";
import type { ContextManager, SessionRecord, SkillRegistry } from "@miniclaw/core";
import { Gateway, type SocketDaemonControls } from "@miniclaw/gateway";
import { SqliteStore } from "@miniclaw/memory-sqlite";
import type { InMemoryStore } from "@miniclaw/memory-inmemory";
import {
  createWikiSkills,
  formatMaintenanceResult,
  MemoryWikiMaintainer,
  MemoryWikiWorker,
  startWikiBrowserServer,
  type WikiBrowserHandle,
} from "@miniclaw/memory-wiki";
import { createCronSkills, createSessionsSkills } from "@miniclaw/agent-skills/runtime";

import type { Config } from "./config.ts";
import { buildLLM, buildSmallLLM } from "./llm.ts";
import { trackLLMUsage } from "./llm-usage.ts";
import { buildToolGuard, describeSecurityMode } from "./security.ts";
import { loadSkills } from "./skills.ts";

export type ConfirmToolFn = (
  call: { name: string; args: unknown },
  skill: { name: string; description: string },
) => Promise<boolean>;

export interface BuildAgentStackOpts {
  /** One-shot launches skip the wiki worker + browser (no background loop). */
  oneShot?: boolean;
  /** Use the stateless context manager (no history / no retrieval). */
  stateless?: boolean;
  /**
   * Per-call confirmation handler baked into the agent's deps. Used by the
   * in-process bypass (readline). The daemon leaves this undefined and answers
   * confirmations per turn over the socket instead (AgentTurnHooks.onConfirmTool).
   */
  confirmTool?: ConfirmToolFn;
}

export interface AgentStack {
  gateway: Gateway;
  registry: SkillRegistry;
  /** Socket-shaped controls (status / usage / dream / wiki / skills / memories). */
  controls: SocketDaemonControls;
  /** The gateway's per-session agent factory (the bypass uses it directly). */
  agentFor: (session: SessionRecord) => Agent;
  wikiWorker: MemoryWikiWorker | null;
  wikiBrowser: WikiBrowserHandle | null;
  agentSkillList: Array<{ name: string; description: string; scope: string }>;
  /** Stop the wiki worker + browser this stack started. The caller closes the store. */
  close(): Promise<void>;
}

/**
 * The single agent-construction site. Builds the LLMs, skills, gateway
 * (with a per-session agent factory), wiki worker/browser, dreamer, and the
 * socket-shaped controls — everything both the daemon (runForeground) and the
 * in-process bypass (runAgent) share. Each caller then adds only its own
 * surface: the daemon adds transports + cron + the socket server; the bypass
 * adds a local readline Harness.
 *
 * `store` is owned by the caller (it picks SqliteStore vs InMemoryStore and
 * closes it); everything created here is torn down by `close()`.
 */
export async function buildAgentStack(
  config: Config,
  store: SqliteStore | InMemoryStore,
  opts: BuildAgentStackOpts = {},
): Promise<AgentStack> {
  const oneShot = opts.oneShot ?? false;
  // Wiki features need the SQLite-backed store; an ephemeral InMemoryStore has none.
  const wikiStore = store instanceof SqliteStore ? store : null;
  const dbPath = wikiStore ? config.dbPath : ":memory:";

  const llm = trackLLMUsage(
    buildLLM(config),
    wikiStore ?? undefined,
    { provider: config.provider, model: config.model, role: "primary" },
  );
  const builtSmallLLM = buildSmallLLM(config);
  const smallLLM = builtSmallLLM && config.smallLLM
    ? trackLLMUsage(
        builtSmallLLM,
        wikiStore ?? undefined,
        { provider: config.smallLLM.provider, model: config.smallLLM.model, role: "small" },
      )
    : undefined;
  const toolGuard = buildToolGuard(config, smallLLM);
  const summarizerLLM = smallLLM ?? llm;

  const { registry, catalog, skills: agentSkillList } = loadSkills({
    home: config.home,
    workspaceRoot: config.workspaceRoot,
  });

  const wikiMaintainer = wikiStore
    ? new MemoryWikiMaintainer({ llm: smallLLM ?? llm, queue: wikiStore, wiki: wikiStore })
    : null;
  const wikiWorker = wikiMaintainer && smallLLM && !oneShot
    ? new MemoryWikiWorker({ maintainer: wikiMaintainer })
    : null;
  const wikiBrowser: WikiBrowserHandle | null = wikiStore && config.wikiBrowser.enabled && !oneShot
    ? await startWikiBrowserServer({
        wiki: wikiStore,
        host: config.wikiBrowser.host,
        port: config.wikiBrowser.port,
        token: config.wikiBrowser.token,
      })
    : null;

  // Per-session agent factory: a fresh ContextManager bound to the session's
  // conversation. confirmTool is baked in only for the in-process bypass; the
  // daemon answers confirmations per turn via AgentTurnHooks.onConfirmTool.
  const agentFor = (session: SessionRecord): Agent => {
    const context: ContextManager = opts.stateless
      ? new StatelessContextManager({ extraSystemPrompt: catalog })
      : new CompactingContextManager({
          memory: store,
          conversations: store,
          conversationId: session.conversationId,
          summarizer: summarizerLLM,
          knowledge: wikiStore ?? undefined,
          workspaceRoot: config.workspaceRoot,
          extraSystemPrompt: catalog,
        });
    return new Agent({
      llm,
      registry,
      context,
      memory: store,
      audit: store,
      dbPath,
      channel: session.channel,
      sessionId: session.id,
      conversationId: session.conversationId,
      workspaceRoot: config.workspaceRoot,
      toolGuard,
      confirmTool: opts.confirmTool,
    });
  };

  const gateway = new Gateway({ sessions: store, conversations: store, agentFor });

  for (const sk of createSessionsSkills(gateway)) if (!registry.has(sk.name)) registry.register(sk);
  for (const sk of createCronSkills(store)) if (!registry.has(sk.name)) registry.register(sk);
  if (wikiStore) {
    for (const sk of createWikiSkills({ wiki: wikiStore, maintainer: wikiMaintainer ?? undefined })) {
      if (!registry.has(sk.name)) registry.register(sk);
    }
  }
  const dreamer = new Dreamer({
    llm: summarizerLLM,
    conversations: store,
    memory: store,
    audit: store,
    registry,
    dbPath,
    workspaceRoot: config.workspaceRoot,
    toolGuard,
  });
  if (!registry.has("dream")) registry.register(createDreamSkill(dreamer));

  const controls: SocketDaemonControls = {
    status: (sessionId, channel, conversationId) => ({
      provider: config.provider,
      model: config.model,
      smallModel: config.smallLLM
        ? `${config.smallLLM.provider}/${config.smallLLM.model}`
        : `(primary ${config.provider}/${config.model})`,
      store: wikiStore ? config.dbPath : "(ephemeral)",
      session: sessionId,
      channel,
      conversation: String(conversationId),
      workspace: config.workspaceRoot,
      security: describeSecurityMode(config),
      wikiBrowser: wikiBrowser?.url ?? "(disabled)",
      skills: String(registry.list().length),
    }),
    usage: () => store.auditUsage(),
    dream: async () => formatDreamRunResult(await dreamer.run()),
    wikiMaintain: async () =>
      wikiMaintainer
        ? formatMaintenanceResult(await wikiMaintainer.drain())
        : "(wiki maintenance is only available with SQLite storage)",
    skills: () => ({
      tools: registry.list().map((s) => ({ name: s.name, description: s.description })),
      skills: agentSkillList,
    }),
    memories: (n) => ({
      rows: store.listRecent(n).map((r) => ({ id: r.id, kind: r.kind, content: r.content })),
    }),
  };

  return {
    gateway,
    registry,
    controls,
    agentFor,
    wikiWorker,
    wikiBrowser,
    agentSkillList,
    close: async () => {
      wikiWorker?.stop();
      await wikiBrowser?.stop();
    },
  };
}
