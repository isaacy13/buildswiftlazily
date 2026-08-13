import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
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
import { logInfo } from "./security.js";

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

const SCRIPT_TIMEOUT_MS = 60 * 60 * 1000;
const HEARTBEAT_MS = 30_000;

export class JobCancelledError extends Error {
  constructor(message = "Build cancelled") {
    super(message);
    this.name = "JobCancelledError";
  }
}

type JobCancelState = {
  aborted: boolean;
  killChild: (() => void) | null;
};

/** Per-job cancel registry so POST /api/jobs/:id/cancel can stop a live build. */
const jobCancel = new Map<string, JobCancelState>();

function ensureCancelState(jobId: string): JobCancelState {
  let state = jobCancel.get(jobId);
  if (!state) {
    state = { aborted: false, killChild: null };
    jobCancel.set(jobId, state);
  }
  return state;
}

export function isJobCancelRequested(jobId: string): boolean {
  return Boolean(jobCancel.get(jobId)?.aborted);
}

/** Request cancel; kills the current child process group if any. Returns false if unknown job. */
export function requestJobCancel(jobId: string): boolean {
  const state = ensureCancelState(jobId);
  state.aborted = true;
  try {
    state.killChild?.();
  } catch {
    /* ignore */
  }
  return true;
}

function clearJobCancel(jobId: string): void {
  jobCancel.delete(jobId);
}

function throwIfCancelled(jobId: string): void {
  if (isJobCancelRequested(jobId)) throw new JobCancelledError();
}

/** Notable lines also echo to the Mac control-plane console (avoid xcodebuild spam). */
function shouldMirrorToConsole(line: string): boolean {
  return /error|warning:|archive|export|upload|validat|testflight|building|signing|codesign|ipa|failed|success|compiling|linking|note:|still running|DRY_RUN|Injected|Checkout|ASC |CFBundle|TESTFLIGHT|altool|Authenticat|Processing|App Store|cancel/i.test(
    line,
  );
}

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return `${min}m${rem ? ` ${rem}s` : ""}`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

/**
 * Run a build helper script, streaming stdout/stderr into the job log as lines
 * arrive (buffered exec made long xcodebuild/altool runs look "stuck" for an hour).
 */
function killProcessTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    // Negative PID = process group (spawned with detached:true).
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }, 8_000).unref?.();
}

export async function runScript(
  jobId: string,
  jobs: JobStore,
  script: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  throwIfCancelled(jobId);
  const basename = path.basename(script);
  jobs.appendLog(jobId, `$ ${basename} ${args.join(" ")}`);
  logInfo(`job ${jobId.slice(0, 8)} start ${basename}`);

  return new Promise((resolve, reject) => {
    const child = spawn(script, args, {
      env: childEnvForScript(basename),
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so cancel can SIGTERM xcodebuild + friends.
      detached: true,
    });

    const cancelState = ensureCancelState(jobId);
    const outLines: string[] = [];
    const errLines: string[] = [];
    let settled = false;
    let lastActivity = Date.now();
    const started = Date.now();

    const stopChild = () => killProcessTree(child);
    cancelState.killChild = stopChild;
    if (cancelState.aborted) stopChild();

    const onLine = (line: string, stream: "out" | "err") => {
      lastActivity = Date.now();
      const text = line.replace(/\r/g, "").trimEnd();
      if (!text.trim()) return;
      if (stream === "out") outLines.push(text);
      else errLines.push(text);
      jobs.appendLog(jobId, text);
      if (shouldMirrorToConsole(text)) {
        const clipped = text.length > 220 ? `${text.slice(0, 200)}…` : text;
        logInfo(`[${basename}] ${clipped}`);
      }
    };

    const rlOut = createInterface({ input: child.stdout! });
    const rlErr = createInterface({ input: child.stderr! });
    rlOut.on("line", (l) => onLine(l, "out"));
    rlErr.on("line", (l) => onLine(l, "err"));

    const heartbeat = setInterval(() => {
      if (isJobCancelRequested(jobId)) {
        stopChild();
        return;
      }
      const elapsed = formatElapsed(Date.now() - started);
      const idleSec = Math.floor((Date.now() - lastActivity) / 1000);
      const msg = `… still running ${basename} (${elapsed} elapsed, last output ${idleSec}s ago)`;
      jobs.appendLog(jobId, msg);
      logInfo(`job ${jobId.slice(0, 8)} ${msg}`);
    }, HEARTBEAT_MS);

    const killer = setTimeout(() => {
      const msg = `TIMEOUT: ${basename} exceeded ${formatElapsed(SCRIPT_TIMEOUT_MS)} — sending SIGTERM`;
      jobs.appendLog(jobId, msg);
      logInfo(`job ${jobId.slice(0, 8)} ${msg}`);
      stopChild();
    }, SCRIPT_TIMEOUT_MS);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(killer);
      if (cancelState.killChild === stopChild) cancelState.killChild = null;
      rlOut.close();
      rlErr.close();
      fn();
    };

    child.on("error", (e) => {
      finish(() => reject(e));
    });

    child.on("close", (code, signal) => {
      finish(() => {
        const stdout = outLines.join("\n");
        const stderr = errLines.join("\n");
        const elapsed = formatElapsed(Date.now() - started);
        if (isJobCancelRequested(jobId)) {
          reject(new JobCancelledError());
          return;
        }
        if (code === 0) {
          jobs.appendLog(jobId, `${basename} finished OK in ${elapsed}`);
          logInfo(`job ${jobId.slice(0, 8)} ${basename} OK in ${elapsed}`);
          resolve({ stdout, stderr });
          return;
        }
        const err = Object.assign(
          new Error(
            `${basename} exited ${code ?? "?"}${signal ? ` signal=${signal}` : ""} after ${elapsed}`,
          ),
          { stdout, stderr, code, signal },
        );
        reject(err);
      });
    });
  });
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

  ensureCancelState(jobId);
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
    throwIfCancelled(jobId);
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

    throwIfCancelled(jobId);

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

    jobs.appendLog(
      jobId,
      mode === "testflight"
        ? "Starting Xcode archive (often 10–40+ min). Live log below — keep this Mac awake."
        : "Starting Xcode archive. Live log below — keep this Mac awake.",
    );
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

    throwIfCancelled(jobId);

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

    throwIfCancelled(jobId);

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

    throwIfCancelled(jobId);

    if (mode === "testflight") {
      const ipa = path.join(outDir, "App.ipa");
      if (dry) fs.writeFileSync(ipa, "dry-run-ipa");
      if (!fs.existsSync(ipa)) throw new Error("IPA missing after build");
      let bver = "";
      if (fs.existsSync(path.join(outDir, "bundle_version.txt"))) {
        bver = fs.readFileSync(path.join(outDir, "bundle_version.txt"), "utf8").trim();
      }
      if (bver) jobs.appendLog(jobId, `CFBundleVersion=${bver} (must be unique per upload)`);
      jobs.appendLog(
        jobId,
        "Uploading IPA to App Store Connect (altool). Do not Ctrl+C the Mac control plane.",
      );
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

    throwIfCancelled(jobId);

    jobs.patch(jobId, {
      status: "succeeded",
      finishedAt: new Date().toISOString(),
    });
    jobs.appendLog(jobId, "Deploy finished successfully");
  } catch (e) {
    if (e instanceof JobCancelledError || isJobCancelRequested(jobId)) {
      jobs.patch(jobId, {
        status: "cancelled",
        error: "Cancelled",
        finishedAt: new Date().toISOString(),
      });
      jobs.appendLog(jobId, "Build cancelled");
      return;
    }
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
  } finally {
    clearJobCancel(jobId);
  }
}
