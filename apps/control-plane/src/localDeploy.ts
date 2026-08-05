import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import type { Env } from "./config.js";
import {
  assertSafeBundleId,
  assertSafeBundleVersion,
  assertSafeConfiguration,
  assertSafeDeployMode,
  assertSafePlatform,
  assertSafeRef,
  assertSafeRelPath,
  assertSafeRepo,
  assertSafeScheme,
  assertSafeTitle,
  expandHome,
  REPO_ROOT,
} from "./config.js";
import type { JobStore } from "./jobs.js";

const execFileAsync = promisify(execFile);

/**
 * Copy gitignored secrets into a tarball checkout before xcodebuild.
 * BSL_CHECKOUT_INJECT entries: `rel/path/in/checkout=/absolute/or/~/source`
 * separated by commas or newlines.
 */
export function injectCheckoutFiles(
  checkoutRoot: string,
  spec: string,
): { dest: string; src: string }[] {
  const copied: { dest: string; src: string }[] = [];
  const entries = spec
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      throw new Error(
        `Invalid BSL_CHECKOUT_INJECT entry "${entry}" (want dest=src)`,
      );
    }
    const destRel = assertSafeRelPath(entry.slice(0, eq).trim());
    const src = expandHome(entry.slice(eq + 1).trim());
    if (!src || src.includes("\0")) {
      throw new Error(`Invalid BSL_CHECKOUT_INJECT source for ${destRel}`);
    }
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      throw new Error(`BSL_CHECKOUT_INJECT source missing: ${src}`);
    }
    const destAbs = path.resolve(checkoutRoot, destRel);
    const rootResolved = path.resolve(checkoutRoot);
    if (
      destAbs !== rootResolved &&
      !destAbs.startsWith(rootResolved + path.sep)
    ) {
      throw new Error(`BSL_CHECKOUT_INJECT dest escapes checkout: ${destRel}`);
    }
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(src, destAbs);
    copied.push({ dest: destRel, src });
  }
  return copied;
}

export type LocalDeployInput = {
  repository: string;
  ref: string;
  project_path?: string;
  scheme: string;
  configuration?: string;
  deploy_mode?: "ota" | "direct" | "both" | "testflight";
  platform?: "ios" | "watchos";
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
  await assertSafeTarball(tgz);
  await execFileAsync("tar", [
    "-xzf",
    tgz,
    "-C",
    extractTo,
    "--strip-components=1",
  ]);
  assertNoSymlinkEscape(extractTo);
  return extractTo;
}

/** Reject path-traversal / absolute / link members before extracting a GitHub tarball. */
async function assertSafeTarball(tgz: string): Promise<void> {
  const { stdout: names } = await execFileAsync("tar", ["-tzf", tgz], {
    maxBuffer: 20 * 1024 * 1024,
    timeout: 60_000,
  });
  for (const line of names.split("\n")) {
    const entry = line.trim();
    if (!entry) continue;
    if (entry.startsWith("/") || entry.includes("..")) {
      throw new Error("Refusing tarball with unsafe path entry");
    }
  }

  // Type flags: reject symlink (l) / hardlink (h) members (GNU + BSD tar -tv).
  const { stdout: listing } = await execFileAsync("tar", ["-tvzf", tgz], {
    maxBuffer: 20 * 1024 * 1024,
    timeout: 60_000,
  });
  for (const line of listing.split("\n")) {
    const entry = line.trim();
    if (!entry) continue;
    const type = entry[0];
    if (type === "l" || type === "h") {
      throw new Error("Refusing tarball with symlink/hardlink entry");
    }
    if (entry.includes(" -> ")) {
      throw new Error("Refusing tarball with symlink/hardlink entry");
    }
  }
}

/** After extract: deny any symlink that resolves outside the checkout root. */
function assertNoSymlinkEscape(root: string): void {
  const absRoot = path.resolve(root);
  const stack = [absRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        let target: string;
        try {
          target = fs.readlinkSync(full);
        } catch {
          throw new Error("Refusing unreadable symlink in checkout");
        }
        if (path.isAbsolute(target) || target.split(/[/\\]/).includes("..")) {
          throw new Error("Refusing symlink escape in checkout");
        }
        const resolved = path.resolve(path.dirname(full), target);
        if (resolved !== absRoot && !resolved.startsWith(absRoot + path.sep)) {
          throw new Error("Refusing symlink escape in checkout");
        }
      } else if (ent.isDirectory()) {
        stack.push(full);
      }
    }
  }
}

/**
 * Env for spawned build scripts. By default strip the login keychain password so
 * install/OTA/TestFlight children (and any Xcode Run Scripts they might wrap)
 * never inherit it. Only `build-ios.sh` needs the password for unlock.
 */
export function childEnvForScript(
  scriptBasename: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  if (scriptBasename !== "build-ios.sh") {
    delete env.BSL_KEYCHAIN_PASSWORD;
  }
  return env;
}

async function runScript(
  jobId: string,
  jobs: JobStore,
  script: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const basename = path.basename(script);
  jobs.appendLog(jobId, `$ ${basename} ${args.join(" ")}`);
  try {
    const { stdout, stderr } = await execFileAsync(script, args, {
      env: childEnvForScript(basename),
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
  const scheme = assertSafeScheme(input.scheme);
  const mode = assertSafeDeployMode(input.deploy_mode || "ota");
  const platform = assertSafePlatform(input.platform || "ios");
  const configuration = assertSafeConfiguration(input.configuration || "Release");
  const title = assertSafeTitle(input.title || scheme);

  jobs.patch(jobId, { status: "running", platform });
  jobs.appendLog(
    jobId,
    `Local deploy ${repository}@${ref} scheme=${scheme} mode=${mode} platform=${platform}`,
  );

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

    const injectSpec = (process.env.BSL_CHECKOUT_INJECT || "").trim();
    if (injectSpec) {
      const copied = injectCheckoutFiles(checkout, injectSpec);
      for (const c of copied) {
        jobs.appendLog(jobId, `Injected ${c.dest} from local file`);
      }
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
      "--platform",
      platform,
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
          const resolved = path.resolve(app);
          if (!resolved.startsWith(path.resolve(outDir) + path.sep)) {
            throw new Error("App path escapes build output directory");
          }
          const deviceClass = platform === "watchos" ? "watch" : "phone";
          await runScript(jobId, jobs, path.join(REPO_ROOT, "scripts/install-direct.sh"), [
            "--app",
            resolved,
            "--device-class",
            deviceClass,
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
        bid = assertSafeBundleId(
          fs.readFileSync(path.join(outDir, "bundle_id.txt"), "utf8"),
        );
      }
      if (fs.existsSync(path.join(outDir, "bundle_version.txt"))) {
        bver = assertSafeBundleVersion(
          fs.readFileSync(path.join(outDir, "bundle_version.txt"), "utf8"),
        );
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
      let bver = "";
      if (fs.existsSync(path.join(outDir, "bundle_version.txt"))) {
        bver = fs.readFileSync(path.join(outDir, "bundle_version.txt"), "utf8").trim();
      }
      if (bver) jobs.appendLog(jobId, `CFBundleVersion=${bver} (must be unique per upload)`);
      const tfArgs = ["--ipa", ipa, "--platform", platform];
      if (dry) tfArgs.push("--dry-run");
      const tf = await runScript(
        jobId,
        jobs,
        path.join(REPO_ROOT, "scripts/upload-testflight.sh"),
        tfArgs,
      );
      const uploaded = /TESTFLIGHT_UPLOAD=ok/.test(`${tf.stdout}\n${tf.stderr}`);
      jobs.patch(jobId, {
        testflightNote: dry
          ? "DRY_RUN: would upload to App Store Connect / TestFlight."
          : uploaded
            ? "Upload accepted. Check App Store Connect → TestFlight → Builds (not only the phone app). Processing is often minutes; Missing Compliance can stall for hours."
            : "Upload finished without TESTFLIGHT_UPLOAD=ok — check the log. If you Ctrl+C’d the Mac shell, re-run; the upload was likely aborted.",
      });
    }

    jobs.patch(jobId, {
      status: "succeeded",
      finishedAt: new Date().toISOString(),
    });
    jobs.appendLog(jobId, "Deploy finished successfully");
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const blob = `${raw}\n${String((e as { stdout?: string; stderr?: string }).stdout || "")}\n${String((e as { stderr?: string }).stderr || "")}`;
    let error = raw;
    if (
      /errSecInteractionNotAllowed|-25308|User interaction is not allowed|CSSMERR_DL_INVALID_ACCESS_CREDENTIALS|codesign.*keychain|failed to sign/i.test(
        blob,
      )
    ) {
      error = `${raw} — Keychain blocked unattended codesign. On the Mac run ./scripts/prepare-keychain.sh (optional: set BSL_KEYCHAIN_PASSWORD in .env). You cannot approve the Keychain dialog from the iPhone.`;
    } else if (
      /Unable to authenticate|AuthKey_|BSL_ASC_KEY|ASC API auth|TESTFLIGHT|altool|No suitable application records|duplicate|CFBundleVersion/i.test(
        blob,
      )
    ) {
      error = `${raw} — TestFlight/ASC upload issue. Confirm BSL_ASC_KEY_ID + ISSUER_ID, AuthKey_*.p8, a unique CFBundleVersion, and an ASC app record for this bundle id. Do not Ctrl+C the Mac control-plane shell mid-upload.`;
    }
    jobs.patch(jobId, {
      status: "failed",
      error,
      finishedAt: new Date().toISOString(),
    });
    jobs.appendLog(jobId, `FAILED: ${error}`);
  }
}
