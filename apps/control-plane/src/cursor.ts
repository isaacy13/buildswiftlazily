import type { Env } from "./config.js";
import { assertSafeAgentId } from "./config.js";

export type CursorAgent = {
  id: string;
  name: string;
  status?: string;
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
  source?: string;
  repos?: { url?: string; branch?: string }[];
  branches?: { repoUrl?: string; branch?: string; prUrl?: string }[];
  latestRunId?: string;
  raw?: unknown;
};

export type CursorMessage = {
  id?: string;
  type: string;
  text: string;
};

async function cursorFetch(
  env: Env,
  apiPath: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!env.cursorApiKey) throw new Error("CURSOR_API_KEY not configured");
  const headers = new Headers(init.headers);
  // Basic auth with API key as username, empty password (Cursor docs)
  const basic = Buffer.from(`${env.cursorApiKey}:`).toString("base64");
  headers.set("Authorization", `Basic ${basic}`);
  headers.set("Accept", "application/json");
  headers.set("User-Agent", "buildswiftlazily");
  return fetch(`https://api.cursor.com${apiPath}`, { ...init, headers });
}

export function isArchivedAgentFields(item: {
  archived?: boolean;
  isArchived?: boolean;
  status?: unknown;
}): boolean {
  return (
    item.isArchived === true ||
    item.archived === true ||
    /archiv/i.test(String(item.status || ""))
  );
}

function normalizeAgent(item: Record<string, unknown>): CursorAgent {
  const id = String(item.id || item.bcId || "");
  const name = String(item.name || item.title || id);
  const status = item.status ? String(item.status) : undefined;
  const archived = isArchivedAgentFields({
    archived: item.archived === true,
    isArchived: item.isArchived === true,
    status,
  });
  const createdAt = item.createdAt
    ? String(item.createdAt)
    : item.createdAtMs
      ? new Date(Number(item.createdAtMs)).toISOString()
      : undefined;
  const updatedAt = item.updatedAt
    ? String(item.updatedAt)
    : item.lastMessageActivityAtMs
      ? new Date(Number(item.lastMessageActivityAtMs)).toISOString()
      : item.updatedAtMs
        ? new Date(Number(item.updatedAtMs)).toISOString()
        : createdAt;
  const url =
    typeof item.url === "string"
      ? item.url
      : id
        ? `https://cursor.com/agents/${id}`
        : undefined;

  const branches: CursorAgent["branches"] = [];
  const git = item.git as { branches?: CursorAgent["branches"] } | undefined;
  if (git?.branches) branches.push(...git.branches);
  const target = item.target as { branchName?: string; url?: string } | undefined;
  if (target?.branchName) {
    branches.push({
      branch: target.branchName,
      repoUrl: target.url,
    });
  }

  return {
    id,
    name,
    status,
    archived,
    createdAt,
    updatedAt,
    url,
    source: item.source ? String(item.source) : undefined,
    latestRunId: item.latestRunId ? String(item.latestRunId) : undefined,
    branches,
    raw: item,
  };
}

export async function listCursorAgents(
  env: Env,
  limit = 30,
): Promise<CursorAgent[]> {
  // Try v1 then v0
  const attempts = [`/v1/agents?limit=${limit}`, `/v0/agents?limit=${limit}`];
  let lastErr: Error | null = null;
  for (const path of attempts) {
    try {
      const res = await cursorFetch(env, path);
      if (!res.ok) {
        lastErr = new Error(`${path} → ${res.status}`);
        continue;
      }
      const data = (await res.json()) as {
        items?: Record<string, unknown>[];
        agents?: Record<string, unknown>[];
      };
      const items = data.items || data.agents || [];
      return items.map(normalizeAgent).filter((a) => a.id);
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw lastErr || new Error("Failed to list Cursor agents");
}

export async function getCursorAgent(
  env: Env,
  id: string,
): Promise<CursorAgent> {
  const safeId = assertSafeAgentId(id);
  for (const path of [`/v1/agents/${safeId}`, `/v0/agents/${safeId}`]) {
    const res = await cursorFetch(env, path);
    if (!res.ok) continue;
    return normalizeAgent((await res.json()) as Record<string, unknown>);
  }
  throw new Error("Agent not found");
}

export async function listCursorRuns(env: Env, agentId: string, limit = 20) {
  const safeId = assertSafeAgentId(agentId);
  const res = await cursorFetch(
    env,
    `/v1/agents/${safeId}/runs?limit=${limit}`,
  );
  if (!res.ok) {
    // v0 may not have runs; return empty
    return [] as {
      id: string;
      status?: string;
      createdAt?: string;
      updatedAt?: string;
      result?: string;
      git?: { branches?: CursorAgent["branches"] };
    }[];
  }
  const data = (await res.json()) as {
    items?: Record<string, unknown>[];
  };
  return (data.items || []).map((r) => ({
    id: String(r.id),
    status: r.status ? String(r.status) : undefined,
    createdAt: r.createdAt ? String(r.createdAt) : undefined,
    updatedAt: r.updatedAt ? String(r.updatedAt) : undefined,
    result: r.result ? String(r.result) : undefined,
    git: r.git as { branches?: CursorAgent["branches"] } | undefined,
  }));
}

export async function getCursorConversation(
  env: Env,
  agentId: string,
): Promise<CursorMessage[]> {
  const safeId = assertSafeAgentId(agentId);
  // v0 conversation endpoint is the richest for full message history
  const res = await cursorFetch(env, `/v0/agents/${safeId}/conversation`);
  if (res.ok) {
    const data = (await res.json()) as {
      messages?: { id?: string; type?: string; text?: string }[];
    };
    return (data.messages || []).map((m) => ({
      id: m.id,
      type: m.type || "unknown",
      text: m.text || "",
    }));
  }

  // Fallback: synthesize from v1 runs (user prompts aren't always present;
  // include assistant results at least)
  const runs = await listCursorRuns(env, agentId, 30);
  const msgs: CursorMessage[] = [];
  for (const run of runs.slice().reverse()) {
    if (run.result) {
      msgs.push({
        id: run.id,
        type: "assistant_message",
        text: run.result,
      });
    }
  }
  return msgs;
}

export async function getCursorAgentDetail(env: Env, agentId: string) {
  const [agent, runs, messages] = await Promise.all([
    getCursorAgent(env, agentId),
    listCursorRuns(env, agentId),
    getCursorConversation(env, agentId),
  ]);

  const userMessages = messages
    .filter((m) => /user/i.test(m.type))
    .map((m) => m.text)
    .filter(Boolean);
  const assistantMessages = messages
    .filter((m) => /assistant/i.test(m.type))
    .map((m) => m.text)
    .filter(Boolean);

  // Merge branch hints from runs
  const branches = [...(agent.branches || [])];
  for (const run of runs) {
    for (const b of run.git?.branches || []) {
      if (
        b.branch &&
        !branches.some((x) => x.branch === b.branch && x.repoUrl === b.repoUrl)
      ) {
        branches.push(b);
      }
    }
  }

  return {
    agent: { ...agent, branches, raw: undefined },
    runs,
    messages,
    userMessages,
    lastUserMessage: userMessages[userMessages.length - 1] || null,
    lastAssistantMessage:
      assistantMessages[assistantMessages.length - 1] ||
      runs.find((r) => r.result)?.result ||
      null,
    cursorUrl: agent.url || `https://cursor.com/agents/${agentId}`,
  };
}

export function scoreGuideAiRelevance(
  agent: CursorAgent,
  guideAiRepo: string,
): number {
  const hay = JSON.stringify(agent).toLowerCase();
  let score = 0;
  if (guideAiRepo && hay.includes(guideAiRepo.toLowerCase())) score += 100;
  if (hay.includes("guideai") || hay.includes("guide-ai")) score += 50;
  if (agent.updatedAt) {
    const age = Date.now() - Date.parse(agent.updatedAt);
    if (!Number.isNaN(age)) score += Math.max(0, 30 - age / (1000 * 60 * 60));
  }
  return score;
}
