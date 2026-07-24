import {
  assertSafeRef,
  assertSafeRelPath,
  assertSafeRepo,
  type Env,
} from "./config.js";

export type GhRepo = {
  full_name: string;
  name: string;
  private: boolean;
  description: string | null;
  updated_at: string;
  default_branch: string;
  html_url: string;
  fork: boolean;
};

async function gh(
  env: Env,
  apiPath: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!env.githubToken) {
    throw new Error("GITHUB_TOKEN not configured");
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${env.githubToken}`);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("User-Agent", "buildswiftlazily");
  return fetch(`https://api.github.com${apiPath}`, { ...init, headers });
}

export async function listPersonalRepos(env: Env, max = 100): Promise<GhRepo[]> {
  const repos: GhRepo[] = [];
  let page = 1;
  while (repos.length < max) {
    const res = await gh(
      env,
      `/user/repos?per_page=100&page=${page}&affiliation=owner&sort=updated`,
    );
    if (!res.ok) {
      throw new Error(`GitHub list repos failed: ${res.status} ${await res.text()}`);
    }
    const batch = (await res.json()) as GhRepo[];
    if (!batch.length) break;
    for (const r of batch) {
      if (!r.fork) repos.push(r);
      if (repos.length >= max) break;
    }
    if (batch.length < 100) break;
    page += 1;
  }
  return repos;
}

export async function listBranches(
  env: Env,
  repository: string,
): Promise<{ name: string; protected: boolean }[]> {
  const repo = assertSafeRepo(repository);
  const out: { name: string; protected: boolean }[] = [];
  let page = 1;
  while (page <= 10) {
    const res = await gh(env, `/repos/${repo}/branches?per_page=100&page=${page}`);
    if (!res.ok) {
      throw new Error(`GitHub branches failed: ${res.status}`);
    }
    const batch = (await res.json()) as { name: string; protected: boolean }[];
    out.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return out;
}

export async function getRepoTreePaths(
  env: Env,
  repository: string,
  ref: string,
): Promise<string[]> {
  const repo = assertSafeRepo(repository);
  const safeRef = assertSafeRef(ref);
  const res = await gh(
    env,
    `/repos/${repo}/git/trees/${encodeURIComponent(safeRef)}?recursive=1`,
  );
  if (!res.ok) {
    throw new Error(`GitHub tree failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    truncated?: boolean;
    tree: { path: string; type: string }[];
  };
  return (data.tree || [])
    .filter((t) => t.type === "blob" || t.type === "tree")
    .map((t) => t.path);
}

export function detectIosProjects(
  paths: string[],
  scanDepth = 4,
): { projectPath: string; kind: "workspace" | "project"; name: string }[] {
  const found: {
    projectPath: string;
    kind: "workspace" | "project";
    name: string;
  }[] = [];
  const seen = new Set<string>();

  for (const p of paths) {
    const parts = p.split("/");
    // skip nested Pods/Carthage/etc
    if (parts.some((x) => ["Pods", "Carthage", ".build", "node_modules"].includes(x))) {
      continue;
    }
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      let kind: "workspace" | "project" | null = null;
      if (seg.endsWith(".xcworkspace")) kind = "workspace";
      else if (seg.endsWith(".xcodeproj")) kind = "project";
      if (!kind) continue;
      // depth = directories before the project bundle
      if (i > scanDepth) continue;
      const dir = parts.slice(0, i).join("/") || ".";
      const key = `${dir}::${kind}::${seg}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        projectPath: dir,
        kind,
        name: seg.replace(/\.(xcworkspace|xcodeproj)$/, ""),
      });
    }
  }

  // If both workspace and project in same dir, keep workspace entries
  const byDir = new Map<string, typeof found>();
  for (const f of found) {
    const list = byDir.get(f.projectPath) || [];
    list.push(f);
    byDir.set(f.projectPath, list);
  }
  const result: typeof found = [];
  for (const list of byDir.values()) {
    const workspaces = list.filter((x) => x.kind === "workspace");
    if (workspaces.length) result.push(...workspaces);
    else result.push(...list);
  }
  return result.sort((a, b) => a.projectPath.localeCompare(b.projectPath));
}

export type DeployInput = {
  repository: string;
  ref: string;
  project_path?: string;
  scheme: string;
  configuration?: string;
  deploy_mode?: "ota" | "direct" | "both";
  title?: string;
};

export async function dispatchDeploy(
  env: Env,
  input: DeployInput,
): Promise<{ id?: number; message: string }> {
  const repository = assertSafeRepo(input.repository);
  const ref = assertSafeRef(input.ref);
  const project_path = assertSafeRelPath(input.project_path || ".");
  const scheme = input.scheme.trim();
  if (!scheme || /[\n\r]/.test(scheme)) throw new Error("Invalid scheme");

  const body = {
    ref: env.toolingRef, // branch of buildswiftlazily that contains deploy-ios.yml
    inputs: {
      repository,
      ref,
      project_path,
      scheme,
      configuration: input.configuration || "Release",
      deploy_mode: input.deploy_mode || "ota",
      title: input.title || scheme,
    },
  };

  const res = await gh(
    env,
    `/repos/${env.toolingRepo}/actions/workflows/deploy-ios.yml/dispatches`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (res.status !== 204) {
    throw new Error(`workflow_dispatch failed: ${res.status} ${await res.text()}`);
  }
  return { message: "Dispatched deploy-ios.yml" };
}

export async function listRecentWorkflowRuns(env: Env, perPage = 10) {
  const res = await gh(
    env,
    `/repos/${env.toolingRepo}/actions/workflows/deploy-ios.yml/runs?per_page=${perPage}`,
  );
  if (!res.ok) throw new Error(`list runs failed: ${res.status}`);
  const data = (await res.json()) as {
    workflow_runs: {
      id: number;
      status: string;
      conclusion: string | null;
      html_url: string;
      created_at: string;
      updated_at: string;
      display_title: string;
      head_sha: string;
      name: string;
    }[];
  };
  return data.workflow_runs;
}

export async function getWorkflowRun(env: Env, runId: number) {
  const res = await gh(env, `/repos/${env.toolingRepo}/actions/runs/${runId}`);
  if (!res.ok) throw new Error(`get run failed: ${res.status}`);
  return res.json();
}
