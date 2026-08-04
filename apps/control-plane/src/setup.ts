import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Env } from "./config.js";
import { REPO_ROOT } from "./config.js";

const execFileAsync = promisify(execFile);

export type SetupItem = {
  id: string;
  label: string;
  ok: boolean;
  required: boolean;
  hint?: string;
};

export async function buildSetupChecklist(env: Env): Promise<{
  readyForOta: boolean;
  readyForTestFlight: boolean;
  readyForLocalBuild: boolean;
  items: SetupItem[];
  platform: string;
}> {
  const items: SetupItem[] = [];
  const isDarwin = process.platform === "darwin";

  items.push({
    id: "platform",
    label: "Running on macOS (Xcode host)",
    ok: isDarwin,
    required: true,
    hint: isDarwin ? undefined : "Control plane should run on your Mac with Xcode",
  });

  let xcode = false;
  try {
    await execFileAsync("xcodebuild", ["-version"]);
    xcode = true;
  } catch {
    xcode = false;
  }
  items.push({
    id: "xcode",
    label: "Xcode / xcodebuild available",
    ok: xcode,
    required: true,
    hint: "Install Xcode + CLI tools on the Mac",
  });

  items.push({
    id: "github",
    label: "GitHub token configured",
    ok: Boolean(env.githubToken),
    required: true,
    hint: "Set GITHUB_TOKEN in .env (Contents: Read + Actions: Write if using Actions engine)",
  });

  const tsHostOk = Boolean(env.tsHost) && !/your-mac\.tailnet/i.test(env.tsHost);
  items.push({
    id: "ts_host",
    label: "Tailscale host (BSL_TS_HOST) for OTA",
    ok: tsHostOk,
    required: false,
    hint: "Required for Ad Hoc OTA install links",
  });

  let tailscale = false;
  const tsCandidates = [
    "tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    `${process.env.HOME || ""}/Applications/Tailscale.app/Contents/MacOS/Tailscale`,
  ];
  for (const bin of tsCandidates) {
    try {
      await execFileAsync(bin, ["status"]);
      tailscale = true;
      break;
    } catch {
      /* try next */
    }
  }
  items.push({
    id: "tailscale",
    label: "Tailscale connected",
    ok: tailscale,
    required: false,
    hint: "Install Tailscale app + CLI on Mac + iPhone for off-LAN OTA",
  });

  const teamOk = Boolean(env.teamId) && env.teamId !== "XXXXXXXXXX";
  items.push({
    id: "team",
    label: "Apple Team ID set",
    ok: teamOk,
    required: false,
    hint: "BSL_TEAM_ID helps automatic signing",
  });

  items.push({
    id: "cursor",
    label: "Cursor API key (Cloud Agents tab)",
    ok: Boolean(env.cursorApiKey),
    required: false,
    hint: "https://cursor.com/dashboard/api",
  });

  const ascKey = Boolean(process.env.BSL_ASC_KEY_ID || process.env.ASC_KEY_ID);
  const ascIssuer = Boolean(process.env.BSL_ASC_ISSUER_ID || process.env.ASC_ISSUER_ID);
  items.push({
    id: "asc",
    label: "App Store Connect API key (TestFlight)",
    ok: ascKey && ascIssuer,
    required: false,
    hint: "BSL_ASC_KEY_ID + BSL_ASC_ISSUER_ID + AuthKey_*.p8 in ~/.appstoreconnect/private_keys",
  });

  const reposYamlPath = path.join(REPO_ROOT, "config/repos.yaml");
  const reposYaml = fs.existsSync(reposYamlPath);
  let guideConfigured = Boolean(env.guideAiRepo) && !/YOUR_/i.test(env.guideAiRepo);
  if (reposYaml) {
    try {
      const text = fs.readFileSync(reposYamlPath, "utf8");
      if (/YOUR_ORG_OR_USER\/GuideAI/.test(text) && !guideConfigured) {
        guideConfigured = false;
      } else if (!/YOUR_ORG_OR_USER\/GuideAI/.test(text)) {
        guideConfigured = true;
      }
    } catch {
      /* ignore */
    }
  }
  items.push({
    id: "repos",
    label: "config/repos.yaml present with GuideAI slug",
    ok: reposYaml && guideConfigured,
    required: false,
    hint: "Copy from config/repos.example.yaml and set GuideAI slug",
  });

  const readyForLocalBuild = isDarwin && xcode && Boolean(env.githubToken);
  const readyForOta = readyForLocalBuild && tsHostOk;
  const readyForTestFlight = readyForLocalBuild && ascKey && ascIssuer;

  return {
    readyForOta,
    readyForTestFlight,
    readyForLocalBuild,
    items,
    platform: process.platform,
  };
}
