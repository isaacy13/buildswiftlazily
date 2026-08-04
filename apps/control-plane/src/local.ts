import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Env } from "./config.js";

const execFileAsync = promisify(execFile);

export async function listDevices(): Promise<{
  available: boolean;
  raw: string;
  phones: string[];
}> {
  try {
    const { stdout } = await execFileAsync(
      "xcrun",
      ["devicectl", "list", "devices"],
      { timeout: 15_000 },
    );
    const phones = stdout
      .split("\n")
      .filter((l) => /iphone/i.test(l))
      .map((l) => l.trim());
    return { available: true, raw: stdout, phones };
  } catch (e) {
    return {
      available: false,
      raw: e instanceof Error ? e.message : String(e),
      phones: [],
    };
  }
}

export function listOtaArtifacts(env: Env) {
  const root = path.join(env.artifactRoot, "www", "ota");
  if (!fs.existsSync(root)) return [];
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const items = [];
  for (const id of dirs) {
    const metaPath = path.join(root, id, "meta.json");
    if (fs.existsSync(metaPath)) {
      try {
        items.push(JSON.parse(fs.readFileSync(metaPath, "utf8")));
        continue;
      } catch {
        /* fallthrough */
      }
    }
    items.push({
      id,
      installUrl: env.tsHost
        ? `https://${env.tsHost}/ota/${id}/`
        : `/ota/${id}/`,
    });
  }
  return items.sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
  );
}

export function healthPayload(env: Env) {
  return {
    ok: true,
    service: "buildswiftlazily",
    tsHost: env.tsHost || null,
    teamIdConfigured: Boolean(env.teamId),
    githubConfigured: Boolean(env.githubToken),
    cursorConfigured: Boolean(env.cursorApiKey),
    // Do not expose absolute local paths on the unauthenticated health endpoint.
    artifactRootConfigured: Boolean(env.artifactRoot),
    time: new Date().toISOString(),
  };
}
