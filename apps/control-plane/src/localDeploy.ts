import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import type { Env } from "./config.js";
import {
  assertSafeRef,
  assertSafeRelPath,
  assertSafeRepo,
  REPO_ROOT,
} from "./config.js";
import type { JobStore } from "./jobs.js";

const execFileAsync = promisify(execFile);

export type LocalDeployInput = {
  repository: string;
  ref: string;
  project_path?: string;
  scheme: string;
  configuration?: string;
  deploy_mode?: "ota" | "direct" | "both" | "testflight";
  title?: string;
};

function hasXcodebuild(): boolean {
  try {
    fs.accessSync("/usr/bin/xcodebuild");
    return true;
  } catch {
    return false;
  }
}

async function downloadGithubTarball(
  env: Env,
  repository: string,
  ref: string,
  destDir: string,
): Promise<string> {
  if (!env.githubToken) throw new Error("GITHUB_TOKEN required to fetch source");
  const url = `https://api.github.com/repos/${repository}/tarball/${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.githubToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "buildswiftlazily",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "follow",
  });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${repository}@${ref}: ${res.status}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  const tgz = path.join(destDir, "src.tgz");
  await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(tgz));
  const extractTo = path.join(destDir, "src");
  fs.mkdirSync(extractTo, { recursive: true });
  await execFileAsync("tar", ["-xzf", tgz, "-C", extractTo, "--strip-components=1"]);
  return extractTo;
}

async function runScript(
  jobId: string,
  jobs: JobStore,
  script: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  jobs.appendLog(jobId, `$ ${path.basename(script)} ${args.join(" ")}`);
  try {
    const { stdout, stderr } = await execFileAsync(script, args, {
      env: { ...process.env },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 60 * 60 * 1000,
    });
    for (const line of `${stdout}\n${stderr}`.split("\n")) {
      if (line.trim()) jobs.appendLog(jobId, line);
    }
    return { stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    for (const line of `${err.stdout || ""}\n${err.stderr || ""}\n${err.message || e}`.split(
      "\n",
    )) {
      if (line.trim()) jobs.appendLog(jobId, line);
    }
    throw e;
  }
}

export async function runLocalDeploy(
  env: Env,
  jobs: JobStore,
  jobId: string,
  input: LocalDeployInput,
): Promise<void> {
  const repository = assertSafeRepo(input.repository);
  const ref = assertSafeRef(input.ref);
  const projectPath = assertSafeRelPath(input.project_path || ".");
  const scheme = input.scheme.trim();
  const mode = input.deploy_mode || "ota";
  const configuration = input.configuration || "Release";
  const title = input.title || scheme;

  jobs.patch(jobId, { status: "running" });
  jobs.appendLog(jobId, `Local deploy ${repository}@${ref} scheme=${scheme} mode=${mode}`);

  const forceDry = process.env.BSL_DRY_RUN === "1";
  const dry = forceDry || !hasXcodebuild();
  if (dry && !forceDry) {
    jobs.appendLog(
      jobId,
      "xcodebuild not found — DRY simulation (normal on non-Mac CI; on your Mac this uses real Xcode)",
    );
  }

  const workRoot = path.join(env.artifactRoot, "work", jobId);
  fs.mkdirSync(workRoot, { recursive: true });

  try {
    jobs.appendLog(jobId, "Fetching source…");
    let checkout: string;
    if (dry && !env.githubToken) {
      checkout = path.join(workRoot, "fixture");
      fs.mkdirSync(path.join(checkout, "Demo.xcodeproj"), { recursive: true });
      fs.writeFileSync(
        path.join(checkout, "Demo.xcodeproj", "project.pbxproj"),
        "// fixture\n",
      );
      jobs.appendLog(jobId, "Using local fixture project (no token / dry-run)");
    } else if (dry && env.githubToken) {
      try {
        checkout = await downloadGithubTarball(env, repository, ref, workRoot);
        jobs.appendLog(jobId, `Checkout ready at ${checkout}`);
      } catch (e) {
        jobs.appendLog(jobId, `Tarball fetch failed (${e}); using fixture`);
        checkout = path.join(workRoot, "fixture");
        fs.mkdirSync(path.join(checkout, `${scheme}.xcodeproj`), { recursive: true });
        fs.writeFileSync(
          path.join(checkout, `${scheme}.xcodeproj`, "project.pbxproj"),
          "// fixture\n",
        );
      }
    } else {
      checkout = await downloadGithubTarball(env, repository, ref, workRoot);
      jobs.appendLog(jobId, `Checkout ready at ${checkout}`);
    }

    const outDir = path.join(env.artifactRoot, "builds", jobId);
    fs.mkdirSync(outDir, { recursive: true });
    const buildScript = path.join(REPO_ROOT, "scripts/build-ios.sh");

    const buildMode =
      mode === "testflight"
        ? "testflight"
        : mode === "direct"
          ? "direct"
          : mode === "both"
            ? "both"
            : "ota";

    await runScript(jobId, jobs, buildScript, [
      "--root",
      checkout,
      "--project-path",
      projectPath,
      "--scheme",
      scheme,
      "--configuration",
      configuration,
      "--out-dir",
      outDir,
      "--mode",
      buildMode,
      ...(env.teamId ? ["--team-id", env.teamId] : []),
      ...(dry ? ["--dry-run"] : []),
    ]);

    if (mode === "direct" || mode === "both") {
      if (dry) {
        jobs.appendLog(jobId, "DRY_RUN: skip devicectl install");
      } else {
        const appPathFile = path.join(outDir, "app_path.txt");
        if (fs.existsSync(appPathFile)) {
          const app = fs
            .readFileSync(appPathFile, "utf8")
            .replace(/^APP_PATH=/, "")
            .trim();
          await runScript(jobId, jobs, path.join(REPO_ROOT, "scripts/install-direct.sh"), [
            "--app",
            app,
          ]);
        }
      }
    }

    if (mode === "ota" || mode === "both") {
      const ipa = path.join(outDir, "App.ipa");
      if (dry) fs.writeFileSync(ipa, "dry-run-ipa");
      if (!fs.existsSync(ipa)) throw new Error("IPA missing after build");
      const tsHost = env.tsHost || (dry ? "example.tailnet.ts.net" : "");
      if (!tsHost) throw new Error("BSL_TS_HOST required for OTA");
      let bid = "com.example.app";
      let bver = "1";
      if (fs.existsSync(path.join(outDir, "bundle_id.txt"))) {
        bid = fs.readFileSync(path.join(outDir, "bundle_id.txt"), "utf8").trim();
      }
      if (fs.existsSync(path.join(outDir, "bundle_version.txt"))) {
        bver = fs.readFileSync(path.join(outDir, "bundle_version.txt"), "utf8").trim();
      }
      const serveArgs = [
        "--ipa",
        ipa,
        "--artifact-id",
        jobId.replace(/[^A-Za-z0-9_-]/g, ""),
        "--title",
        title,
        "--bundle-id",
        bid,
        "--bundle-version",
        bver,
        "--ts-host",
        tsHost,
      ];
      if (dry) serveArgs.push("--dry-run");
      const serve = await runScript(
        jobId,
        jobs,
        path.join(REPO_ROOT, "scripts/serve-ota.sh"),
        serveArgs,
      );
      const install = serve.stdout.match(/^INSTALL_URL=(.+)$/m)?.[1];
      const itms = serve.stdout.match(/^ITMS_URL=(.+)$/m)?.[1];
      jobs.patch(jobId, { installUrl: install, itmsUrl: itms });
      jobs.appendLog(jobId, `Install page: ${install}`);
    }

    if (mode === "testflight") {
      const ipa = path.join(outDir, "App.ipa");
      if (dry) fs.writeFileSync(ipa, "dry-run-ipa");
      if (!fs.existsSync(ipa)) throw new Error("IPA missing after build");
      const tfArgs = ["--ipa", ipa];
      if (dry) tfArgs.push("--dry-run");
      await runScript(jobId, jobs, path.join(REPO_ROOT, "scripts/upload-testflight.sh"), tfArgs);
      jobs.patch(jobId, {
        testflightNote:
          dry
            ? "DRY_RUN: would upload to App Store Connect / TestFlight."
            : "Uploaded to App Store Connect. Processing can take a few minutes — open TestFlight.",
      });
    }

    jobs.patch(jobId, {
      status: "succeeded",
      finishedAt: new Date().toISOString(),
    });
    jobs.appendLog(jobId, "Deploy finished successfully");
  } catch (e) {
    jobs.patch(jobId, {
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
      finishedAt: new Date().toISOString(),
    });
    jobs.appendLog(jobId, `FAILED: ${e}`);
  }
}
