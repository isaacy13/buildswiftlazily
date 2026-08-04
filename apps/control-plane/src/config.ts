import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../../..");

export type RepoConfigEntry = {
  id: string;
  repository: string;
  display_name?: string;
  project_path?: string;
  scheme?: string;
  bundle_id?: string;
  favorite?: boolean;
};

export type AppConfig = {
  discovery: { mode: "personal"; max_repos: number; scan_depth: number };
  defaults: {
    favorite: string;
    deploy_mode: "ota" | "direct" | "both" | "testflight";
    configuration: string;
  };
  repos: RepoConfigEntry[];
};

export type Env = {
  tsHost: string;
  controlPort: number;
  otaPort: number;
  teamId: string;
  artifactRoot: string;
  artifactTtlDays: number;
  githubToken: string;
  cursorApiKey: string;
  guideAiRepo: string;
  toolingRepo: string;
  toolingRef: string;
  /** Prefer local builds on the Mac (works when Actions runner is down). */
  deployEngine: "local" | "actions";
  /**
   * Optional shared secret for control-plane API (defense in depth beyond Tailscale).
   * When set, mutating + sensitive API routes require Bearer / X-BSL-Token.
   */
  apiToken: string;
};

function loadDotEnv(file: string) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

export function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

export function loadEnv(): Env {
  loadDotEnv(path.join(REPO_ROOT, ".env"));
  const artifactRoot = expandHome(
    process.env.BSL_ARTIFACT_ROOT ||
      path.join(os.homedir(), "buildswiftlazily/artifacts"),
  );
  return {
    tsHost: process.env.BSL_TS_HOST || "",
    controlPort: Number(process.env.BSL_CONTROL_PORT || 8787),
    otaPort: Number(process.env.BSL_OTA_PORT || 8788),
    teamId: process.env.BSL_TEAM_ID || "",
    artifactRoot,
    artifactTtlDays: Number(process.env.BSL_ARTIFACT_TTL_DAYS || 7),
    githubToken:
      process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
    cursorApiKey: process.env.CURSOR_API_KEY || "",
    guideAiRepo: process.env.BSL_GUIDEAI_REPO || "",
    toolingRepo:
      process.env.BSL_TOOLING_REPO || "isaacy13/buildswiftlazily",
    toolingRef: process.env.BSL_TOOLING_REF || "main",
    deployEngine:
      process.env.BSL_DEPLOY_ENGINE === "actions" ? "actions" : "local",
    apiToken: process.env.BSL_API_TOKEN || "",
  };
}

export function loadRepoConfig(): AppConfig {
  const preferred = path.join(REPO_ROOT, "config/repos.yaml");
  const fallback = path.join(REPO_ROOT, "config/repos.example.yaml");
  const file = fs.existsSync(preferred) ? preferred : fallback;
  const raw = yaml.load(fs.readFileSync(file, "utf8")) as AppConfig;
  return {
    discovery: {
      mode: "personal",
      max_repos: raw.discovery?.max_repos ?? 100,
      scan_depth: raw.discovery?.scan_depth ?? 4,
    },
    defaults: {
      favorite: raw.defaults?.favorite ?? "guideai",
      deploy_mode: raw.defaults?.deploy_mode ?? "ota",
      configuration: raw.defaults?.configuration ?? "Release",
    },
    repos: raw.repos ?? [],
  };
}

export function assertSafeRef(ref: string): string {
  if (
    !ref ||
    ref.length > 256 ||
    ref.includes("..") ||
    /[\n\r;|$`\\&<>(){}[\]!]/.test(ref) ||
    !/^[A-Za-z0-9._/\-]+$/.test(ref)
  ) {
    throw new Error("Invalid git ref");
  }
  return ref;
}

export function assertSafeRepo(repo: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("Invalid repository slug");
  }
  return repo;
}

export function assertSafeRelPath(p: string): string {
  const normalized = p.replace(/\\/g, "/") || ".";
  if (
    normalized.startsWith("/") ||
    normalized.includes("..") ||
    /[\n\r;|$`\\]/.test(normalized)
  ) {
    throw new Error("Invalid project path");
  }
  return normalized;
}

/** Xcode scheme names — keep shell/metacharacter-safe. */
export function assertSafeScheme(scheme: string): string {
  const s = scheme.trim();
  if (!s || s.length > 128 || !/^[A-Za-z0-9._+\- ]+$/.test(s)) {
    throw new Error("Invalid scheme");
  }
  return s;
}

export function assertSafeConfiguration(configuration: string): string {
  const c = configuration.trim();
  if (!c || c.length > 64 || !/^[A-Za-z0-9._+\-]+$/.test(c)) {
    throw new Error("Invalid configuration");
  }
  return c;
}

export function assertSafeTitle(title: string): string {
  const t = title.trim();
  if (!t) return "App";
  if (t.length > 128 || /[\n\r\x00-\x08\x0b\x0c\x0e-\x1f]/.test(t)) {
    throw new Error("Invalid title");
  }
  return t;
}

export function assertSafeDeployMode(
  mode: string,
): "ota" | "direct" | "both" | "testflight" {
  if (mode === "ota" || mode === "direct" || mode === "both" || mode === "testflight") {
    return mode;
  }
  throw new Error("Invalid deploy_mode");
}

export function assertSafeAgentId(id: string): string {
  if (!id || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("Invalid agent id");
  }
  return id;
}
